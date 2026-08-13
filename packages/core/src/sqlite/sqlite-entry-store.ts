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

  constructor(driver: SqliteDriver) {
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
