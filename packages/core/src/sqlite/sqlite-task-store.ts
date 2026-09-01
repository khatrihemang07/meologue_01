import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  assertValidDate,
  assertValidDeadline,
  assertValidDuration,
  assertValidPriority,
  withDefaultSchedulingFields,
} from "../task-fields";
import type { TaskStore } from "../task-store";
import type { Task } from "../task-types";
import type { SqliteDriver } from "./driver";
import { kv, tasks } from "./schema";

/**
 * The SQLite-backed TaskStore (ADR 0047), platform-free — mirrors
 * SqliteEntryStore (./sqlite-entry-store.ts) closely enough that a reader
 * of one recognises the other, including its hand-maintained FTS index
 * and the same non-atomicity it carries. Use ./open.ts rather than this
 * constructor directly: `tasks_fts` (migration 5) has to exist before
 * this can index anything into it, the same way `entries_fts` (migration
 * 2) has to exist before SqliteEntryStore can.
 */
export class SqliteTaskStore implements TaskStore {
  private readonly db: ReturnType<typeof drizzle>;
  private readonly driver: SqliteDriver;

  constructor(driver: SqliteDriver) {
    this.driver = driver;
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
  }

  async list(): Promise<Task[]> {
    // Active: not completed, not tombstoned — mirrors
    // SqliteEntryStore.list()'s `deleted_at IS NULL` filter, with a
    // second clause for the state Entries never had (completion).
    // `tasks_order_key_id_idx` (../schema.ts) is a composite index on
    // exactly (order_key, id), so SQLite can walk it directly for this
    // ORDER BY instead of a full scan.
    return this.db
      .select()
      .from(tasks)
      .where(and(isNull(tasks.completedAt), isNull(tasks.deletedAt)))
      .orderBy(tasks.orderKey, tasks.id);
  }

  async listCompleted(): Promise<Task[]> {
    // Newest completion first, ties broken by id descending — mirrors
    // SqliteEntryStore.list()'s createdAt-desc/id-desc reasoning: Task
    // ids are time-ordered uuidv7 (../id.ts), so an ascending tie-break
    // would order same-millisecond completions oldest-first inside an
    // otherwise newest-first list. Tombstones excluded, same as list().
    return this.db
      .select()
      .from(tasks)
      .where(and(sql`${tasks.completedAt} is not null`, isNull(tasks.deletedAt)))
      .orderBy(desc(tasks.completedAt), desc(tasks.id));
  }

  async get(id: string): Promise<Task | undefined> {
    const [found] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
      .limit(1);
    return found;
  }

  async upsert(newTasks: Task[]): Promise<void> {
    if (newTasks.length === 0) {
      return;
    }
    // withDefaultSchedulingFields fills date/deadline/duration/priority
    // in for a caller that omits them (Task.priority's own doc comment on
    // why that key is TS-optional at all) — done once here, before the
    // insert, rather than trusted to drizzle's own handling of a missing
    // object key, so the row this statement actually writes is never in
    // doubt.
    const normalized = newTasks.map(withDefaultSchedulingFields);
    // A single statement (mirrors SqliteEntryStore.upsert — see ADR
    // 0007): SQLite's native upsert applies each conflicting row's own
    // `excluded` values, so this stays correct for a batch of unrelated
    // Tasks, not just a single one.
    await this.db
      .insert(tasks)
      .values(normalized)
      .onConflictDoUpdate({
        target: tasks.id,
        set: {
          deviceId: sql`excluded.device_id`,
          content: sql`excluded.content`,
          completedAt: sql`excluded.completed_at`,
          orderKey: sql`excluded.order_key`,
          createdAt: sql`excluded.created_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
          date: sql`excluded.date`,
          deadline: sql`excluded.deadline`,
          duration: sql`excluded.duration`,
          priority: sql`excluded.priority`,
        },
      });
    for (const t of normalized) {
      await this.indexForSearch(t);
    }
  }

  async complete(id: string, completedAt: string): Promise<void> {
    await this.updateIfLive(id, { completedAt, seq: null, syncedAt: null });
  }

  async uncomplete(id: string): Promise<void> {
    await this.updateIfLive(id, { completedAt: null, seq: null, syncedAt: null });
  }

  /**
   * Changes a Task's content locally — mirrors SqliteEntryStore.edit's
   * doc comment for why this can't just be "build a mutated Task and
   * upsert() it": the search index has to be kept in step with the new
   * content, or search keeps surfacing the Task by words no longer in
   * it, and this has to no-op against a tombstone so a stale local rename
   * can never resurrect a Task someone else deleted.
   */
  async rename(id: string, content: string): Promise<void> {
    await this.updateIfLive(id, { content, seq: null, syncedAt: null });
    // reindexFromCurrentState (not indexForSearch(patch) directly) re-reads
    // whatever the database now actually holds, so this is correct
    // whether the UPDATE above matched a row or was blocked by the
    // tombstone guard — see SqliteEntryStore.edit's identical comment.
    await this.reindexFromCurrentState(id);
  }

  /**
   * Changes a Task's orderKey locally. Writes exactly one row — the
   * `WHERE id = ?` UPDATE below touches only this Task's own row, never a
   * sibling's, which is the entire point of fractional indexing (ADR
   * 0050 — see ../order-key.ts's header comment for what an
   * every-sibling rewrite would cost under this migrator and under
   * concurrent offline drags). No-op against a tombstone.
   */
  async reorder(id: string, orderKey: string): Promise<void> {
    await this.updateIfLive(id, { orderKey, seq: null, syncedAt: null });
  }

  async setDate(id: string, date: string | null): Promise<void> {
    assertValidDate(date);
    await this.updateIfLive(id, { date, seq: null, syncedAt: null });
  }

  async setDeadline(id: string, deadline: string | null): Promise<void> {
    assertValidDeadline(deadline);
    await this.updateIfLive(id, { deadline, seq: null, syncedAt: null });
  }

  // Reads the Task's current `date` first, unlike every other setter here
  // — assertValidDuration's "requires a timed date" rule spans two
  // columns, so there's nothing to validate against without a read. This
  // is also why an unknown or tombstoned id no-ops *before* validation
  // runs rather than after: "no-op against a tombstone" is unconditional
  // for every mutator on this store (see TaskStore.setDuration's doc
  // comment), and a row that doesn't exist has no `date` to validate
  // against in the first place.
  async setDuration(id: string, duration: number | null): Promise<void> {
    const current = await this.get(id);
    if (current === undefined) {
      return;
    }
    assertValidDuration(duration, current.date);
    await this.updateIfLive(id, { duration, seq: null, syncedAt: null });
  }

  async setPriority(id: string, priority: number): Promise<void> {
    assertValidPriority(priority);
    await this.updateIfLive(id, { priority, seq: null, syncedAt: null });
  }

  /**
   * Removes a Task from Todo locally — mirrors SqliteEntryStore.remove's
   * doc comment for why this can't just be "build a mutated Task and
   * upsert() it," including the resurrection trap: `seq IS NULL` can mean
   * either "never pushed" or "pushed, response lost," and this store
   * can't tell those apart, so it never hard-deletes in that window
   * either.
   */
  async remove(id: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({ deletedAt: new Date().toISOString(), content: "", seq: null, syncedAt: null })
      .where(eq(tasks.id, id));
    await this.reindexFromCurrentState(id);
  }

  // Tombstones awaiting push are included here, not filtered out — see
  // SqliteEntryStore.pending()'s identical comment: a delete goes out
  // over the wire as the resulting state (ADR 0028's Decision, applied to
  // Tasks), so this needs no tombstone-specific logic.
  async pending(): Promise<Task[]> {
    return this.db.select().from(tasks).where(isNull(tasks.seq));
  }

  async getCursor(): Promise<number> {
    // Shares the `kv` table entries' cursor already lives in, but under
    // its own key: reusing CURSOR_KEY (../sqlite/schema.ts) would collide
    // the two streams' progress into one number, and ADR 0047's
    // Consequences name a Task's Sync stream as its own (issue #171/
    // #175) — it needs its own cursor, not a shared one. Until that
    // stream exists this simply stays at 0.
    const value = await this.getKv(TASK_CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setCursor(seq: number): Promise<void> {
    await this.setKv(TASK_CURSOR_KEY, String(seq));
  }

  async search(query: string): Promise<Task[]> {
    const trimmed = query.trim();
    if (trimmed === "") {
      return [];
    }
    // Excludes both tombstoned and completed Tasks — see
    // TaskStore.search's doc comment for why a completed Task doesn't
    // belong in "find something I still need to act on." Ordered to
    // match list()'s own order (order_key asc, id asc), mirroring
    // SqliteEntryStore.search's "same order as list()" guarantee.
    const result = await this.driver.execute(
      `SELECT tasks.id, tasks.device_id, tasks.content, tasks.completed_at, tasks.order_key, tasks.created_at, tasks.seq, tasks.synced_at, tasks.deleted_at, tasks.date, tasks.deadline, tasks.duration, tasks.priority
       FROM tasks_fts
       JOIN tasks ON tasks.id = tasks_fts.id
       WHERE tasks_fts MATCH ? AND tasks.deleted_at IS NULL AND tasks.completed_at IS NULL
       ORDER BY tasks.order_key ASC, tasks.id ASC`,
      [toPrefixMatchQuery(trimmed)],
      "all",
    );
    return result.rows.map(rowToTask);
  }

  // A local mutation against an unknown or already-tombstoned id is a
  // no-op — the structural guard ADR 0028 established for edit/remove
  // (checked on the write itself, not as policy code ahead of it),
  // applied to every one of a Task's local mutations.
  private async updateIfLive(id: string, patch: Partial<Task>): Promise<void> {
    await this.db
      .update(tasks)
      .set(patch)
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)));
  }

  // Re-derives tasks_fts for one Task from whatever `tasks` currently
  // holds for it, rather than from what a caller assumed it just wrote —
  // mirrors SqliteEntryStore's identical private method and the same
  // reasoning: correct whether the preceding UPDATE matched a row or was
  // blocked by the tombstone guard.
  private async reindexFromCurrentState(id: string): Promise<void> {
    const [current] = await this.db
      .select({ content: tasks.content, deletedAt: tasks.deletedAt })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    if (current === undefined) {
      return;
    }
    await this.indexForSearch({ id, content: current.content, deletedAt: current.deletedAt });
  }

  // DELETE-then-INSERT, not atomic across the two statements (no
  // transaction — ADR 0007) — mirrors SqliteEntryStore.indexForSearch's
  // identical technique and the identical trade-off: a process that dies
  // between the two statements leaves this Task temporarily missing from
  // Search, which is self-healing (the next write that touches this id
  // redelivers the INSERT) rather than lossy, and is worth naming rather
  // than leaving as a silent race.
  private async indexForSearch(t: Pick<Task, "id" | "content" | "deletedAt">): Promise<void> {
    await this.driver.execute("DELETE FROM tasks_fts WHERE id = ?", [t.id], "run");
    if (t.deletedAt !== null) {
      return;
    }
    await this.driver.execute(
      "INSERT INTO tasks_fts (id, content) VALUES (?, ?)",
      [t.id, t.content],
      "run",
    );
  }

  private async getKv(key: string): Promise<string | undefined> {
    const rows = await this.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).limit(1);
    return rows[0]?.value;
  }

  private async setKv(key: string, value: string): Promise<void> {
    await this.db
      .insert(kv)
      .values({ key, value })
      .onConflictDoUpdate({ target: kv.key, set: { value } });
  }
}

// Namespaced apart from CURSOR_KEY (../sqlite/schema.ts) — see
// getCursor()'s comment: a Task's Sync stream is its own (ADR 0047),
// so its progress can't share the Entry stream's cursor key without the
// two streams silently clobbering each other's progress in the same kv
// row.
const TASK_CURSOR_KEY = "task_cursor";

/**
 * Builds an FTS5 MATCH expression that searches for `text` literally —
 * mirrors SqliteEntryStore's toPrefixMatchQuery exactly (see its comment
 * for the escaping and prefix-match mechanics; identical here because
 * FTS5's phrase-quoting behaviour doesn't depend on which table it's
 * matching against).
 */
function toPrefixMatchQuery(text: string): string {
  return `"${text.replaceAll('"', '""')}"*`;
}

// Asserted here rather than cast, mirroring SqliteEntryStore's
// rowToEntry — a row that doesn't match the shape this query asked for
// throws instead of silently mis-mapping a value into the wrong field.
function rowToTask(row: unknown): Task {
  if (!Array.isArray(row) || row.length !== 13) {
    throw new Error(`sqlite search expected a 13-column tasks row, got ${JSON.stringify(row)}`);
  }
  const [
    id,
    deviceId,
    content,
    completedAt,
    orderKey,
    createdAt,
    seq,
    syncedAt,
    deletedAt,
    date,
    deadline,
    duration,
    priority,
  ] = row as [
    string,
    string,
    string,
    string | null,
    string,
    string,
    number | null,
    string | null,
    string | null,
    string | null,
    string | null,
    number | null,
    number,
  ];
  return {
    id,
    deviceId,
    content,
    completedAt,
    orderKey,
    createdAt,
    seq,
    syncedAt,
    deletedAt,
    date,
    deadline,
    duration,
    priority,
  };
}
