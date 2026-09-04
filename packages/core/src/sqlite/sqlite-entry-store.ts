import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { mintId } from "../id";
import type { EntryPage, EntryStore } from "../store";
import type { Entry } from "../types";
import type { SqliteDriver } from "./driver";
import { CURSOR_KEY, DEVICE_ID_KEY, entries, kv, ROW_SHAPE_EPOCH_KEY } from "./schema";

/**
 * The SQLite-backed EntryStore (ADR 0007), platform-free — it talks to a
 * database only through the injected SqliteDriver. Use ./open.ts rather
 * than this constructor directly: it also runs migrations and resolves
 * this Device's id.
 */
export class SqliteEntryStore implements EntryStore {
  private readonly db: ReturnType<typeof drizzle>;
  private readonly driver: SqliteDriver;

  constructor(driver: SqliteDriver) {
    this.driver = driver;
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
  }

  async list(page?: EntryPage): Promise<Entry[]> {
    // Tombstones (ADR 0028) are excluded — a removed Entry has nothing
    // left worth showing in History. The row itself stays, permanently:
    // this is a query filter, not the store forgetting the Entry existed.
    const notDeleted = isNull(entries.deletedAt);
    // `page.before` bounds this to Entries strictly *older* than the
    // cursor in this method's own order (createdAt desc, then id desc —
    // see the WHERE below and the ORDER BY it must agree with). That's an
    // OR across two comparisons, not a single one, because the tie-break
    // means "older" isn't just "smaller createdAt": a same-createdAt row
    // with a smaller id is also older. `entries_created_at_id_idx`
    // (schema.ts) is a composite index on exactly (createdAt, id), so
    // SQLite can walk it directly for both this predicate and the ORDER BY
    // instead of a full scan — the same index the unpaged query already
    // relied on for its ORDER BY alone.
    const where = page?.before
      ? and(
          notDeleted,
          or(
            lt(entries.createdAt, page.before.createdAt),
            and(eq(entries.createdAt, page.before.createdAt), lt(entries.id, page.before.id)),
          ),
        )
      : notDeleted;
    const query = this.db
      .select()
      .from(entries)
      .where(where)
      .orderBy(desc(entries.createdAt), desc(entries.id));
    // Applied conditionally rather than always calling .limit() with a
    // sentinel "no cap" value: an explicit branch says plainly that "no
    // limit" and "some limit" are two different requests, rather than
    // leaning on a magic number to mean unbounded.
    return page?.limit === undefined ? query : query.limit(page.limit);
  }

  /**
   * See EntryStore.getMany's doc comment for the contract this owes
   * callers. A single `WHERE id IN (...) AND deleted_at IS NULL` per
   * chunk, not one query per id — see `GET_MANY_CHUNK_SIZE`'s own comment
   * for why this is chunked at all rather than one IN-list of arbitrary
   * size.
   */
  async getMany(ids: string[]): Promise<Entry[]> {
    if (ids.length === 0) {
      return [];
    }
    const results: Entry[] = [];
    for (const chunk of chunkIds(ids)) {
      const rows = await this.db
        .select()
        .from(entries)
        .where(and(inArray(entries.id, chunk), isNull(entries.deletedAt)));
      results.push(...rows);
    }
    return results;
  }

  async upsert(newEntries: Entry[]): Promise<void> {
    if (newEntries.length === 0) {
      return;
    }
    // A single statement (see ADR 0007) — SQLite's native upsert applies
    // each conflicting row's own `excluded` values, so this stays correct
    // for a batch of unrelated Entries, not just a single one.
    await this.db
      .insert(entries)
      .values(newEntries)
      .onConflictDoUpdate({
        target: entries.id,
        set: {
          deviceId: sql`excluded.device_id`,
          body: sql`excluded.body`,
          createdAt: sql`excluded.created_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
      });
    for (const entry of newEntries) {
      await this.indexForSearch(entry);
    }
  }

  async search(query: string): Promise<Entry[]> {
    const trimmed = query.trim();
    if (trimmed === "") {
      return [];
    }
    // `entries.deleted_at is null` excludes tombstones, same as list() —
    // a removed Entry's body is blanked (ADR 0028) anyway, so it would
    // never match a real query, but excluding it explicitly keeps this
    // query correct even if that ever stopped being true.
    const result = await this.driver.execute(
      `SELECT entries.id, entries.device_id, entries.body, entries.created_at, entries.seq, entries.synced_at, entries.deleted_at
       FROM entries_fts
       JOIN entries ON entries.id = entries_fts.id
       WHERE entries_fts MATCH ? AND entries.deleted_at IS NULL
       ORDER BY entries.created_at DESC, entries.id DESC`,
      [toPrefixMatchQuery(trimmed)],
      "all",
    );
    return result.rows.map(rowToEntry);
  }

  /**
   * Changes an Entry's body locally (ADR 0028) — see EntryStore.edit's
   * doc comment for why this can't just be "build a mutated Entry and
   * upsert() it."
   *
   * `WHERE deleted_at IS NULL` mirrors the server's own guard
   * (`fn edit_entry`/the sync handler's `where entries.deleted_at is
   * null`, ADR 0028): a stale local edit against an Entry this Device
   * doesn't yet know was deleted elsewhere matches no row and no-ops,
   * rather than reviving a tombstone. The next sync pulls the tombstone
   * and this Device converges to deleted like everyone else.
   *
   * Setting `seq = null` is the whole mechanism that gets this edit
   * pushed — it looks incidental but it is the point. pending() (below)
   * is already `seq IS NULL`, so clearing it is what makes this edited
   * Entry show up there; the sync engine (../sync-engine.ts) already
   * pushes everything pending() returns, unmodified. No new sync code was
   * needed for edits because this one field reuses the exact mechanism
   * that already pushes new Entries.
   */
  async edit(id: string, body: string): Promise<void> {
    await this.db
      .update(entries)
      .set({ body, seq: null, syncedAt: null })
      .where(and(eq(entries.id, id), isNull(entries.deletedAt)));
    // The guard above is structural, on the write itself (ADR 0028: delete
    // is enforced this way, "not as policy code checked before it") — so
    // there's no pre-check here to say whether the UPDATE actually
    // matched a row. reindexFromCurrentState re-derives the index from
    // whatever the database now actually holds for this id, which is
    // correct whether the UPDATE landed (a real edit) or was blocked by
    // the guard (a no-op against an unknown id or a tombstone) — for a
    // tombstone this still needs to run, since a stale entries_fts row
    // from before the delete could otherwise keep surfacing it in Search.
    await this.reindexFromCurrentState(id);
  }

  /**
   * Removes an Entry from History locally (ADR 0028) — see
   * EntryStore.remove's doc comment for why this can't just be "build a
   * mutated Entry and upsert() it."
   *
   * Blanking `body` alongside setting `deletedAt` keeps the row from
   * asserting two contradictory things at once ("deleted" and "still says
   * X") — see ADR 0028's Decision section. Clearing `seq` is the same
   * push mechanism edit() uses.
   *
   * This never hard-deletes the row, including while `seq` is already
   * null. `seq IS NULL` means "no acknowledgement from the server yet,"
   * and that covers two situations this Device cannot tell apart: this
   * delete hasn't been pushed yet, or it has been pushed and the response
   * was lost. Hard-deleting here and syncing again means the next pull
   * can return the Entry as live — because the server still has it live,
   * or because the tombstone push never actually landed — with a fresh
   * `seq`, and the Entry comes back permanently. Leaving the tombstone in
   * place, `seq` or no `seq`, is what keeps that window safe.
   */
  async remove(id: string): Promise<void> {
    await this.db
      .update(entries)
      .set({ deletedAt: new Date().toISOString(), body: "", seq: null, syncedAt: null })
      .where(eq(entries.id, id));
    // See indexForSearch: reading the row back after the write, rather
    // than assuming what we just wrote, is what makes this correct
    // whether `id` was a real Entry or unknown (the update above then
    // matched nothing and this is a genuine no-op).
    await this.reindexFromCurrentState(id);
  }

  // Re-derives entries_fts for one Entry from whatever entries currently
  // holds for it, rather than from what a caller assumed it just wrote —
  // see edit()'s comment for why that matters. Used after both edit() and
  // remove(), whose writes are guarded or otherwise not guaranteed to have
  // matched a row.
  private async reindexFromCurrentState(id: string): Promise<void> {
    const [current] = await this.db
      .select({ body: entries.body, deletedAt: entries.deletedAt })
      .from(entries)
      .where(eq(entries.id, id))
      .limit(1);
    if (current === undefined) {
      // Nothing in entries for this id — an edit() or remove() against an
      // id that was never a real Entry. Nothing to index.
      return;
    }
    await this.indexForSearch({ id, body: current.body, deletedAt: current.deletedAt });
  }

  // Before ADR 0028, Entries were immutable and this only ever needed an
  // INSERT (see ADR 0014's original reasoning, now superseded by its own
  // amendment). Now a changed body needs the index row updated, and a
  // tombstone (blanked body, nothing worth matching a search against —
  // ADR 0028) needs it removed outright, not indexed with an empty body.
  //
  // DELETE-then-INSERT is the simplest form that's correct for both a
  // changed body and a redelivered-unchanged one, and it's idempotent on
  // its own if re-run — re-deleting a row that's already gone, or
  // re-inserting the same (id, body) pair, both leave the index in the
  // same state. What it isn't is atomic across the two statements: no
  // transaction wraps this (ADR 0007), so a process that dies between the
  // DELETE and the INSERT leaves this Entry temporarily missing from
  // Search. That's self-healing, not lossy — the next write that touches
  // this Entry (upsert, edit, or a redelivery) redelivers the INSERT —
  // but it's real and worth naming rather than leaving as a silent race.
  private async indexForSearch(entry: Pick<Entry, "id" | "body" | "deletedAt">): Promise<void> {
    await this.driver.execute("DELETE FROM entries_fts WHERE id = ?", [entry.id], "run");
    if (entry.deletedAt !== null) {
      // Tombstone: nothing worth matching a Search against, so the index
      // row is removed outright rather than reinserted with a blank body.
      return;
    }
    await this.driver.execute(
      "INSERT INTO entries_fts (id, body) VALUES (?, ?)",
      [entry.id, entry.body],
      "run",
    );
  }

  // Tombstones awaiting push are included here, not filtered out: a
  // removed Entry has `seq IS NULL` exactly like a newly captured one
  // (ADR 0028's Decision — a delete goes out over the wire as the
  // resulting state, same as any other change), so this needs no
  // tombstone-specific logic to pick them up. The sync engine pushes
  // whatever this returns unmodified.
  async pending(): Promise<Entry[]> {
    return this.db.select().from(entries).where(isNull(entries.seq));
  }

  async getCursor(): Promise<number> {
    const value = await this.getKv(CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setCursor(seq: number): Promise<void> {
    await this.setKv(CURSOR_KEY, String(seq));
  }

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for the mechanism this implements. Reset before
  // record: a process killed between the two leaves getCursor() at 0 and
  // ROW_SHAPE_EPOCH_KEY stale, which repeats this same reset harmlessly
  // on the next call rather than silently skipping it.
  async catchUpRowShapeEpoch(currentEpoch: number): Promise<void> {
    const stored = await this.getKv(ROW_SHAPE_EPOCH_KEY);
    const storedEpoch = stored === undefined ? 0 : Number(stored);
    if (storedEpoch >= currentEpoch) {
      return;
    }
    await this.setCursor(0);
    await this.setKv(ROW_SHAPE_EPOCH_KEY, String(currentEpoch));
  }

  /** Resolves this Device's id, minting and persisting one on first run. */
  async ensureDeviceId(): Promise<string> {
    const existing = await this.getKv(DEVICE_ID_KEY);
    if (existing !== undefined) {
      return existing;
    }
    const id = mintId();
    await this.setKv(DEVICE_ID_KEY, id);
    return id;
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

// SQLite caps how many bound parameters a single statement can carry
// (`SQLITE_MAX_VARIABLE_NUMBER`) — 999 on a build compiled against the
// pre-3.32.0 default, tens of thousands on a build compiled with the newer
// one; getMany() has no way to know at runtime which this driver's
// underlying SQLite was compiled with, since SqliteDriver (./driver.ts) is
// platform-free and doesn't expose it. 500 is comfortably under even the
// old, stricter cap while still batching almost every real Grounding
// disclosure (issue #79's regression fix — dozens of ids, not thousands)
// into one round trip; a very large `ids` list just costs more than one
// statement, correctly, rather than one call risking `ids.length` params
// against a limit it can't check.
const GET_MANY_CHUNK_SIZE = 500;

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += GET_MANY_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + GET_MANY_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Builds an FTS5 MATCH expression that searches for `text` literally, as a
 * prefix, no matter what it contains. A double-quoted string is a phrase
 * FTS5 tokenizes but never parses — AND/OR/NOT, column filters and
 * parentheses inside it are just tokens to match, not query syntax — and
 * a trailing `*` turns its last token into a prefix match (ADR 0014).
 * Escaping doubles any literal `"`, FTS5's own escape for one inside a
 * quoted string, so the query can never end up unbalanced.
 */
function toPrefixMatchQuery(text: string): string {
  return `"${text.replaceAll('"', '""')}"*`;
}

// The columns search() selects, in order — asserted here rather than cast,
// so a row that doesn't match the shape this query asked for throws
// instead of silently mis-mapping a value into the wrong field (the
// failure mode row-mapping.ts's toPositionalRow guards against for every
// other query in this store; this one bypasses drizzle, so it needs its
// own version of the same guard).
function rowToEntry(row: unknown): Entry {
  if (!Array.isArray(row) || row.length !== 7) {
    throw new Error(`sqlite search expected a 7-column entries row, got ${JSON.stringify(row)}`);
  }
  const [id, deviceId, body, createdAt, seq, syncedAt, deletedAt] = row as [
    string,
    string,
    string,
    string,
    number | null,
    string | null,
    string | null,
  ];
  return { id, deviceId, body, createdAt, seq, syncedAt, deletedAt };
}
