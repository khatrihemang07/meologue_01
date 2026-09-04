import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  assertValidFilterColour,
  assertValidFilterName,
  assertValidFilterQuery,
  withDefaultFilterColour,
} from "../filter-fields";
import type { FilterStore } from "../filter-store";
import type { Filter } from "../filter-types";
import type { SqliteDriver } from "./driver";
import { filters, kv } from "./schema";

/**
 * The SQLite-backed FilterStore (issue #185) — mirrors SqliteLabelStore
 * (./sqlite-label-store.ts) closely enough that a reader of one
 * recognises the other, including the same non-atomicity every store
 * built against ../migrator.ts's transaction-free driver carries. See
 * ./open.ts rather than this constructor directly: `filters` (migration
 * 16) has to exist before this can query it.
 */
export class SqliteFilterStore implements FilterStore {
  private readonly db: ReturnType<typeof drizzle>;

  constructor(driver: SqliteDriver) {
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
  }

  async list(): Promise<Filter[]> {
    // Alphabetical, case-insensitively — ../filter-store.ts's own header
    // comment explains why this table has no orderKey to sort by
    // instead, mirroring SqliteLabelStore.list()'s identical choice for
    // the identical reason.
    return this.db
      .select()
      .from(filters)
      .where(isNull(filters.deletedAt))
      .orderBy(asc(sql`lower(${filters.name})`), asc(filters.id));
  }

  async get(id: string): Promise<Filter | undefined> {
    const [found] = await this.db
      .select()
      .from(filters)
      .where(and(eq(filters.id, id), isNull(filters.deletedAt)))
      .limit(1);
    return found;
  }

  async upsert(newFilters: Filter[]): Promise<void> {
    if (newFilters.length === 0) {
      return;
    }
    const normalized = newFilters.map(withDefaultFilterColour);
    await this.db
      .insert(filters)
      .values(normalized)
      .onConflictDoUpdate({
        target: filters.id,
        set: {
          deviceId: sql`excluded.device_id`,
          name: sql`excluded.name`,
          colour: sql`excluded.colour`,
          query: sql`excluded.query`,
          createdAt: sql`excluded.created_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
      });
  }

  async rename(id: string, name: string): Promise<void> {
    assertValidFilterName(name);
    await this.updateIfLive(id, { name, seq: null, syncedAt: null });
  }

  async setColour(id: string, colour: string): Promise<void> {
    assertValidFilterColour(colour);
    await this.updateIfLive(id, { colour, seq: null, syncedAt: null });
  }

  async setQuery(id: string, query: string): Promise<void> {
    assertValidFilterQuery(query);
    await this.updateIfLive(id, { query, seq: null, syncedAt: null });
  }

  /**
   * Tombstones a Filter — never a hard delete (ADR 0028's rule). Blanks
   * `name` for the identical reason SqliteLabelStore.remove() blanks
   * `name`: a tombstone that still carried its old name would assert
   * "removed" and "still called X" about the same row at once.
   */
  async remove(id: string): Promise<void> {
    await this.db
      .update(filters)
      .set({ deletedAt: new Date().toISOString(), name: "", seq: null, syncedAt: null })
      .where(eq(filters.id, id));
  }

  async pending(): Promise<Filter[]> {
    return this.db.select().from(filters).where(isNull(filters.seq));
  }

  async getCursor(): Promise<number> {
    // Namespaced apart from every other stream's cursor key, mirroring
    // SqliteLabelStore.getCursor's own comment.
    const value = await this.getKv(FILTER_CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setCursor(seq: number): Promise<void> {
    await this.setKv(FILTER_CURSOR_KEY, String(seq));
  }

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts). Nothing calls this yet (../filter-store.ts's
  // own header comment: Filters carry no Sync stream), but it exists on
  // every store regardless, the identical posture that comment names.
  async catchUpRowShapeEpoch(currentEpoch: number): Promise<void> {
    const stored = await this.getKv(FILTER_ROW_SHAPE_EPOCH_KEY);
    const storedEpoch = stored === undefined ? 0 : Number(stored);
    if (storedEpoch >= currentEpoch) {
      return;
    }
    await this.setCursor(0);
    await this.setKv(FILTER_ROW_SHAPE_EPOCH_KEY, String(currentEpoch));
  }

  // Mirrors SqliteLabelStore.updateIfLive exactly.
  private async updateIfLive(id: string, patch: Partial<Filter>): Promise<void> {
    await this.db
      .update(filters)
      .set(patch)
      .where(and(eq(filters.id, id), isNull(filters.deletedAt)));
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

const FILTER_CURSOR_KEY = "filter_cursor";

// Issue #186 / ADR 0057: the Filter stream's own row-shape-epoch key.
const FILTER_ROW_SHAPE_EPOCH_KEY = "filter_row_shape_epoch";
