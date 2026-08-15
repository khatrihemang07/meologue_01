import { desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { mintId } from "../id";
import type { EntryStore } from "../store";
import type { Entry } from "../types";
import type { SqliteDriver } from "./driver";
import { CURSOR_KEY, DEVICE_ID_KEY, entries, kv } from "./schema";

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

  async list(): Promise<Entry[]> {
    return this.db.select().from(entries).orderBy(desc(entries.createdAt), desc(entries.id));
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
    const result = await this.driver.execute(
      `SELECT entries.id, entries.device_id, entries.body, entries.created_at, entries.seq, entries.synced_at
       FROM entries_fts
       JOIN entries ON entries.id = entries_fts.id
       WHERE entries_fts MATCH ?
       ORDER BY entries.created_at DESC, entries.id DESC`,
      [toPrefixMatchQuery(trimmed)],
      "all",
    );
    return result.rows.map(rowToEntry);
  }

  // Entries are immutable and never deleted (see the domain glossary), so
  // the search index only ever needs an insert — never an update or a
  // delete. The `WHERE NOT EXISTS` guard keeps this idempotent: Sync can
  // redeliver an Entry this Device already has, and that must not
  // duplicate its index row. See ADR 0014 for why this happens here, in
  // the store's own write path, rather than via a database trigger.
  private async indexForSearch(entry: Entry): Promise<void> {
    await this.driver.execute(
      `INSERT INTO entries_fts (id, body)
       SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM entries_fts WHERE id = ?)`,
      [entry.id, entry.body, entry.id],
      "run",
    );
  }

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
  if (!Array.isArray(row) || row.length !== 6) {
    throw new Error(`sqlite search expected a 6-column entries row, got ${JSON.stringify(row)}`);
  }
  const [id, deviceId, body, createdAt, seq, syncedAt] = row as [
    string,
    string,
    string,
    string,
    number | null,
    string | null,
  ];
  return { id, deviceId, body, createdAt, seq, syncedAt };
}
