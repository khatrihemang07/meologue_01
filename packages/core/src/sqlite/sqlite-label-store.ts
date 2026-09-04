import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  assertValidLabelColour,
  assertValidLabelName,
  withDefaultLabelColour,
} from "../label-fields";
import type { LabelStore } from "../label-store";
import type { Label } from "../label-types";
import type { SqliteDriver } from "./driver";
import { kv, labels } from "./schema";

/**
 * The SQLite-backed LabelStore (issue #170) — mirrors SqliteTaskStore
 * (./sqlite-task-store.ts) closely enough that a reader of one recognises
 * the other, including the same non-atomicity every store built against
 * ../migrator.ts's transaction-free driver carries. See ./open.ts rather
 * than this constructor directly: `labels` (migration 8) has to exist
 * before this can query it.
 */
export class SqliteLabelStore implements LabelStore {
  private readonly db: ReturnType<typeof drizzle>;

  // Unlike SqliteTaskStore, this store never drops to a raw
  // driver.execute() of its own (no FTS5 index, no search()) — so, unlike
  // that store, there's no need to keep the driver itself around as a
  // field, only to build `db` from it here.
  constructor(driver: SqliteDriver) {
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
  }

  async list(): Promise<Label[]> {
    // Alphabetical, case-insensitively — ../label-store.ts's own header
    // comment explains why this table has no orderKey to sort by
    // instead. `lower(name)` is computed at query time rather than kept
    // in its own column: this table has no expected size where a
    // functional index would earn its cost, and a second stored copy of
    // `name` is one more place an update could forget to keep in step.
    return this.db
      .select()
      .from(labels)
      .where(isNull(labels.deletedAt))
      .orderBy(asc(sql`lower(${labels.name})`), asc(labels.id));
  }

  async get(id: string): Promise<Label | undefined> {
    const [found] = await this.db
      .select()
      .from(labels)
      .where(and(eq(labels.id, id), isNull(labels.deletedAt)))
      .limit(1);
    return found;
  }

  async upsert(newLabels: Label[]): Promise<void> {
    if (newLabels.length === 0) {
      return;
    }
    // withDefaultLabelColour — see SqliteTaskStore.upsert's identical
    // call on withDefaultSchedulingFields for why this runs once here
    // rather than being left to drizzle's handling of a missing key.
    const normalized = newLabels.map(withDefaultLabelColour);
    await this.db
      .insert(labels)
      .values(normalized)
      .onConflictDoUpdate({
        target: labels.id,
        set: {
          deviceId: sql`excluded.device_id`,
          name: sql`excluded.name`,
          colour: sql`excluded.colour`,
          createdAt: sql`excluded.created_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
      });
  }

  async rename(id: string, name: string): Promise<void> {
    assertValidLabelName(name);
    await this.updateIfLive(id, { name, seq: null, syncedAt: null });
  }

  async setColour(id: string, colour: string): Promise<void> {
    assertValidLabelColour(colour);
    await this.updateIfLive(id, { colour, seq: null, syncedAt: null });
  }

  /**
   * Tombstones a Label — never a hard delete (ADR 0028's rule). Blanks
   * `name` for the identical reason SqliteTaskStore.remove() blanks
   * `content`: a tombstone that still carried its old name would assert
   * "removed" and "still called X" about the same row at once.
   */
  async remove(id: string): Promise<void> {
    await this.db
      .update(labels)
      .set({ deletedAt: new Date().toISOString(), name: "", seq: null, syncedAt: null })
      .where(eq(labels.id, id));
  }

  async pending(): Promise<Label[]> {
    return this.db.select().from(labels).where(isNull(labels.seq));
  }

  async getCursor(): Promise<number> {
    // Namespaced apart from Entry's and Task's cursor keys for the same
    // reason SqliteTaskStore.getCursor's own comment gives: a shared key
    // would collide two independent streams' progress into one number.
    const value = await this.getKv(LABEL_CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setCursor(seq: number): Promise<void> {
    await this.setKv(LABEL_CURSOR_KEY, String(seq));
  }

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for the mechanism.
  async catchUpRowShapeEpoch(currentEpoch: number): Promise<void> {
    const stored = await this.getKv(LABEL_ROW_SHAPE_EPOCH_KEY);
    const storedEpoch = stored === undefined ? 0 : Number(stored);
    if (storedEpoch >= currentEpoch) {
      return;
    }
    await this.setCursor(0);
    await this.setKv(LABEL_ROW_SHAPE_EPOCH_KEY, String(currentEpoch));
  }

  // Mirrors SqliteTaskStore.updateIfLive exactly — see its own comment
  // for why a mutation against an unknown or tombstoned id is a no-op
  // rather than an error.
  private async updateIfLive(id: string, patch: Partial<Label>): Promise<void> {
    await this.db
      .update(labels)
      .set(patch)
      .where(and(eq(labels.id, id), isNull(labels.deletedAt)));
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

const LABEL_CURSOR_KEY = "label_cursor";

// Issue #186 / ADR 0057: the Label stream's own row-shape-epoch key.
const LABEL_ROW_SHAPE_EPOCH_KEY = "label_row_shape_epoch";
