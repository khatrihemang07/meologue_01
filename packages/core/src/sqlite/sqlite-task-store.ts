import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { withDefaultLabelIds } from "../label-fields";
import { nextOccurrence, tomorrowOf } from "../recurrence";
import {
  assertValidDate,
  assertValidDeadline,
  assertValidNestingDepth,
  assertValidPriority,
  hasTime,
  withDefaultDateString,
  withDefaultDayOrder,
  withDefaultDescription,
  withDefaultSchedulingFields,
  withDefaultStructureFields,
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

  // See TaskStore.listByProject's own doc comment for why this stays a
  // separate query rather than narrowing list() above. `tasks_project_id_idx`
  // (../schema.ts) is what makes the `project_id = ?` filter cheap.
  async listByProject(projectId: string | null): Promise<Task[]> {
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          isNull(tasks.completedAt),
          isNull(tasks.deletedAt),
          isNull(tasks.parentId),
          projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, projectId),
        ),
      )
      .orderBy(tasks.orderKey, tasks.id);
  }

  // See TaskStore.listChildren's own doc comment. `tasks_parent_id_idx`
  // (../schema.ts) is what makes the `parent_id = ?` filter cheap.
  async listChildren(parentId: string): Promise<Task[]> {
    return this.db
      .select()
      .from(tasks)
      .where(and(isNull(tasks.completedAt), isNull(tasks.deletedAt), eq(tasks.parentId, parentId)))
      .orderBy(tasks.orderKey, tasks.id);
  }

  // See TaskStore.listInSection's own doc comment for why both active and
  // completed Tasks are included here, unlike listByProject/listChildren
  // above.
  async listInSection(sectionId: string): Promise<Task[]> {
    return this.db
      .select()
      .from(tasks)
      .where(and(isNull(tasks.deletedAt), eq(tasks.sectionId, sectionId)));
  }

  // See TaskStore.listDescendants' own doc comment. A breadth-first walk:
  // each pass fetches every live child of the current frontier in one
  // query (`parent_id IN (...)`), bounded to at most three passes by the
  // four-level nesting cap, regardless of how many Tasks a Project holds.
  async listDescendants(id: string): Promise<Task[]> {
    const descendants: Task[] = [];
    let frontier = [id];
    while (frontier.length > 0) {
      const children = await this.db
        .select()
        .from(tasks)
        .where(and(isNull(tasks.deletedAt), inArray(tasks.parentId, frontier)));
      descendants.push(...children);
      frontier = children.map((c) => c.id);
    }
    return descendants;
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
    // withDefaultSchedulingFields fills date/deadline/priority
    // in for a caller that omits them (Task.priority's own doc comment on
    // why that key is TS-optional at all) — done once here, before the
    // insert, rather than trusted to drizzle's own handling of a missing
    // object key, so the row this statement actually writes is never in
    // doubt. withDefaultLabelIds (../label-fields.ts) does the identical
    // job for `labelIds` (issue #170) — a separate function, not folded
    // into withDefaultSchedulingFields, because the two fields don't
    // share a ticket, a module, or a reason to default: `labelIds`
    // defaults to `[]` for "no Labels yet," not for a scheduling rule.
    // withDefaultDateString (../task-fields.ts) is a third such
    // defaulter, kept separate again for the same reason: `null` means
    // "doesn't repeat" (issue #170's recurrence engine), not a
    // scheduling rule. withDefaultStructureFields (issue #171) is a
    // fourth, for `projectId`/`sectionId`/`parentId` — `null` means
    // Inbox/no Section/top-level, kept separate for the identical reason
    // the others are: it doesn't share a ticket, module, or default
    // rationale with any of the three before it.
    const normalized = newTasks
      .map(withDefaultSchedulingFields)
      .map(withDefaultLabelIds)
      .map(withDefaultDateString)
      .map(withDefaultStructureFields)
      .map(withDefaultDescription)
      .map(withDefaultDayOrder);
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
          dayOrder: sql`excluded.day_order`,
          createdAt: sql`excluded.created_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
          date: sql`excluded.date`,
          deadline: sql`excluded.deadline`,
          priority: sql`excluded.priority`,
          labelIds: sql`excluded.label_ids`,
          dateString: sql`excluded.date_string`,
          projectId: sql`excluded.project_id`,
          sectionId: sql`excluded.section_id`,
          parentId: sql`excluded.parent_id`,
          description: sql`excluded.description`,
        },
      });
    for (const t of normalized) {
      await this.indexForSearch(t);
    }
  }

  // Reads the Task first, like setParent/postpone below, so the
  // cascade below only runs against a live Task's own children — not
  // when updateIfLive would have silently no-opped against a tombstone.
  async complete(id: string, completedAt: string): Promise<void> {
    const current = await this.get(id);
    if (current === undefined) {
      return;
    }
    await this.updateIfLive(id, { completedAt, seq: null, syncedAt: null });
    await this.completeChildren(id, completedAt);
  }

  // Completing a parent completes its sub-tasks along with it
  // (TaskStore.complete's own doc comment) — recurses through complete()
  // itself, not a flat loop, so a grandchild is reached too, bounded by
  // the four-level nesting cap. Only active children are touched: an
  // already-completed child keeps its own honest `completedAt` (see that
  // same doc comment).
  private async completeChildren(parentId: string, completedAt: string): Promise<void> {
    const children = await this.listChildren(parentId);
    for (const child of children) {
      await this.complete(child.id, completedAt);
    }
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

  /**
   * Changes a Task's dayOrder locally — the Today-shaped sibling of
   * reorder() above (issue #182). Writes exactly one row via the
   * identical `WHERE id = ?` UPDATE, and leaves `orderKey` untouched:
   * dragging in Today never reaches into a Task's Project position.
   * No-op against a tombstone.
   */
  async reorderToday(id: string, dayOrder: string): Promise<void> {
    await this.updateIfLive(id, { dayOrder, seq: null, syncedAt: null });
  }

  async setDate(id: string, date: string | null): Promise<void> {
    assertValidDate(date);
    await this.updateIfLive(id, { date, seq: null, syncedAt: null });
  }

  async setDeadline(id: string, deadline: string | null): Promise<void> {
    assertValidDeadline(deadline);
    await this.updateIfLive(id, { deadline, seq: null, syncedAt: null });
  }

  async setPriority(id: string, priority: number): Promise<void> {
    assertValidPriority(priority);
    await this.updateIfLive(id, { priority, seq: null, syncedAt: null });
  }

  // Replaces `labelIds` wholesale — see TaskStore.setLabelIds's own doc
  // comment for why there's no addLabel/removeLabel pair. No validation
  // beyond the array shape TypeScript already gives: an id naming a
  // Label that's been removed is an accepted, transient state (this
  // file's own header comment, and ../label-store.ts's remove()).
  async setLabelIds(id: string, labelIds: string[]): Promise<void> {
    await this.updateIfLive(id, { labelIds, seq: null, syncedAt: null });
  }

  // See TaskStore.setDescription's own doc comment. No validation beyond
  // the string shape itself — a Description is free-form Markdown.
  async setDescription(id: string, description: string | null): Promise<void> {
    await this.updateIfLive(id, { description, seq: null, syncedAt: null });
  }

  // See TaskStore.setProject's own doc comment for why `sectionId` is
  // cleared unconditionally alongside `projectId`.
  async setProject(id: string, projectId: string | null): Promise<void> {
    await this.updateIfLive(id, { projectId, sectionId: null, seq: null, syncedAt: null });
  }

  async setSection(id: string, sectionId: string | null): Promise<void> {
    await this.updateIfLive(id, { sectionId, seq: null, syncedAt: null });
  }

  // See TaskStore.setParent's own doc comment for the three shapes this
  // refuses. Reads the target Task first, mirroring complete above:
  // "no-op against a tombstone" for `id` itself is unconditional, checked
  // before any of `parentId`'s own validation runs.
  async setParent(id: string, parentId: string | null): Promise<void> {
    const current = await this.get(id);
    if (current === undefined) {
      return;
    }
    if (parentId !== null) {
      if (parentId === id) {
        throw new Error(`Task ${id} cannot be its own parent`);
      }
      let cursor = await this.get(parentId);
      if (cursor === undefined) {
        throw new Error(`setParent: parent Task ${parentId} does not exist or is tombstoned`);
      }
      // depth starts at 1 — `parentId`'s own depth (1 = top-level) — and
      // this walk both counts it and, by checking for `id` along the way,
      // catches a cycle: `parentId` can only be a legal target if `id`
      // is not already one of its own ancestors.
      let depth = 1;
      const visited = new Set<string>([parentId]);
      while (cursor.parentId !== null) {
        if (cursor.parentId === id) {
          throw new Error(
            `setParent: Task ${id} is already an ancestor of ${parentId} — this would create a cycle`,
          );
        }
        if (visited.has(cursor.parentId)) {
          throw new Error(
            `setParent: ${parentId}'s own ancestor chain already cycles at ${cursor.parentId}`,
          );
        }
        visited.add(cursor.parentId);
        const next = await this.get(cursor.parentId);
        if (next === undefined) {
          break;
        }
        cursor = next;
        depth++;
      }
      assertValidNestingDepth(depth);
    }
    await this.updateIfLive(id, { parentId, seq: null, syncedAt: null });
  }

  // See TaskStore.advanceRecurring's own doc comment for the full
  // reasoning; this is its mechanics. Reads the Task first (mirrors
  // setParent's own reasoning above): "no-op against a tombstone" has
  // to be checked before either throw below becomes reachable, and
  // there's no `dateString` to re-parse for a row that isn't live in the
  // first place.
  async advanceRecurring(id: string, completedAt: string): Promise<void> {
    const current = await this.get(id);
    if (current === undefined) {
      return;
    }
    if (current.dateString === null || current.dateString === undefined) {
      throw new Error(
        `advanceRecurring called on Task ${id}, which has no recurrence (dateString is null)`,
      );
    }
    // ../task-views.ts's today() reads `now` the identical way — only the
    // calendar day matters to ../recurrence/'s engine, never the exact
    // instant a completion happened at.
    const now = completedAt.slice(0, 10);
    const outcome = nextOccurrence(current.dateString, { dueDate: current.date, now });
    if (outcome.kind === "refused") {
      throw new Error(
        `Task ${id}'s stored recurrence "${current.dateString}" no longer parses: ${outcome.reason}`,
      );
    }
    if (outcome.kind === "ended") {
      // The bounded rule's window has passed — files as an ordinary
      // completed Task, exactly like completeForever() below, cascading
      // to active sub-tasks for the identical reason (TaskStore.complete's
      // own doc comment).
      await this.updateIfLive(id, { completedAt, dateString: null, seq: null, syncedAt: null });
      await this.completeChildren(id, completedAt);
      return;
    }
    // `completedAt` is deliberately absent from this patch — a recurring
    // Task never enters the completed list (TaskStore.advanceRecurring's
    // own doc comment); only `date` moves.
    await this.updateIfLive(id, { date: outcome.date, seq: null, syncedAt: null });
  }

  // See TaskStore.completeForever's own doc comment for the full
  // reasoning; this is its mechanics. Reads the Task first, like
  // complete() above, so the cascade only runs against a live Task.
  async completeForever(id: string, completedAt: string): Promise<void> {
    const current = await this.get(id);
    if (current === undefined) {
      return;
    }
    await this.updateIfLive(id, { completedAt, dateString: null, seq: null, syncedAt: null });
    await this.completeChildren(id, completedAt);
  }

  // See TaskStore.postpone's own doc comment for the full reasoning;
  // this is its mechanics. Reads the Task first, the same as
  // setParent/advanceRecurring above, to know whether `date` carries a
  // time-of-day to preserve on the new day — postpone has no rule of its
  // own to re-parse, but it still needs the Task's *current* shape.
  async postpone(id: string, today: string): Promise<void> {
    const current = await this.get(id);
    if (current === undefined || current.date === null) {
      return;
    }
    const tomorrow = tomorrowOf(today);
    const nextDate = hasTime(current.date) ? `${tomorrow}T${current.date.slice(11, 16)}` : tomorrow;
    await this.updateIfLive(id, { date: nextDate, seq: null, syncedAt: null });
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
      `SELECT tasks.id, tasks.device_id, tasks.content, tasks.completed_at, tasks.order_key, tasks.day_order, tasks.created_at, tasks.seq, tasks.synced_at, tasks.deleted_at, tasks.date, tasks.deadline, tasks.priority, tasks.label_ids, tasks.date_string, tasks.project_id, tasks.section_id, tasks.parent_id, tasks.description
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
  if (!Array.isArray(row) || row.length !== 19) {
    throw new Error(`sqlite search expected a 19-column tasks row, got ${JSON.stringify(row)}`);
  }
  const [
    id,
    deviceId,
    content,
    completedAt,
    orderKey,
    dayOrder,
    createdAt,
    seq,
    syncedAt,
    deletedAt,
    date,
    deadline,
    priority,
    labelIdsJson,
    dateString,
    projectId,
    sectionId,
    parentId,
    description,
  ] = row as [
    string,
    string,
    string,
    string | null,
    string,
    string,
    string,
    number | null,
    string | null,
    string | null,
    string | null,
    string | null,
    number,
    string,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ];
  return {
    id,
    deviceId,
    content,
    completedAt,
    orderKey,
    dayOrder,
    createdAt,
    seq,
    syncedAt,
    deletedAt,
    date,
    deadline,
    priority,
    // This query runs through this.driver.execute directly rather than
    // drizzle's query builder, so none of drizzle's `{ mode: "json" }`
    // handling (../schema.ts's `labelIds` column) applies here — this is
    // the one place in this store that has to do the JSON.parse itself.
    labelIds: JSON.parse(labelIdsJson) as string[],
    dateString,
    projectId,
    sectionId,
    parentId,
    description,
  };
}
