import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  assertValidLabelColour,
  assertValidLabelName,
  withDefaultLabelColour,
} from "../label-fields";
import type { AcknowledgedLabel, LabelStore } from "../label-store";
import type { Label } from "../label-types";
import type { SqliteDriver } from "./driver";
import { kv, labels } from "./schema";

/**
 * See SqliteEntryStore's own identical constant (./sqlite-entry-store.ts)
 * for the full reasoning — this is the same normalisation, applied to
 * `labels.updated_at` instead of `entries.updated_at`. Kept as its own
 * constant, not imported, because these stores intentionally share no
 * runtime code (ADR 0047), only the shape of the fix.
 */
const MILLISECOND_PRECISION = "%Y-%m-%dT%H:%M:%f";

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
  // Issue #196 — see SqliteEntryStore's own identical field for the
  // mechanism and why it's injectable.
  private readonly now: () => string;

  // Unlike SqliteTaskStore, this store never drops to a raw
  // driver.execute() of its own (no FTS5 index, no search()) — so, unlike
  // that store, there's no need to keep the driver itself around as a
  // field, only to build `db` from it here.
  constructor(driver: SqliteDriver, now: () => string = () => new Date().toISOString()) {
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
    this.now = now;
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
          updatedAt: sql`excluded.updated_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
      });
  }

  /**
   * Issue #218 — see LabelStore.applyPulled's own doc comment (../label-
   * store.ts) and EntryStore.applyPulled's (../store.ts), which carries
   * the full rule and the reasoning behind every clause. Mirrors
   * SqliteEntryStore.applyPulled's own `setWhere` shape (./sqlite-entry-
   * store.ts) exactly, applied to `labels` instead of `entries`. No
   * search index to maintain here — Labels have none — so, unlike
   * SqliteTaskStore.applyPulled, there is no re-read/reindex step after
   * the write.
   */
  async applyPulled(incoming: Label[]): Promise<void> {
    if (incoming.length === 0) {
      return;
    }
    const normalized = incoming.map(withDefaultLabelColour);
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
          updatedAt: sql`excluded.updated_at`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
        setWhere: sql`${labels.seq} IS NOT NULL OR strftime('${sql.raw(MILLISECOND_PRECISION)}', excluded.updated_at) >= strftime('${sql.raw(MILLISECOND_PRECISION)}', ${labels.updatedAt}) OR excluded.deleted_at IS NOT NULL`,
      });
  }

  /**
   * Issue #332 — see LabelStore.applyAcknowledged's own doc comment
   * (../label-store.ts) for the rule and what not having it cost, and
   * AcknowledgedLabel's for why the row as pushed has to travel alongside
   * the confirmation. Mirrors SqliteTaskStore.applyAcknowledged
   * (../sqlite/sqlite-task-store.ts) statement for statement, applied to
   * `labels` instead of `tasks`; that method's own comment carries the
   * reasoning for each of the choices repeated here:
   *
   * - One guarded statement **per row**, unlike applyPulled's single batch
   *   upsert — forced rather than chosen, because each row's guard compares
   *   against its own `asPushed.updatedAt` and a single `setWhere` cannot
   *   carry a different value per row of a batch. The guard still sits
   *   inside the statement, so there is no `await` between deciding and
   *   writing — which matters here for exactly the reason this method
   *   exists: it is about a write that interleaves with a Sync round trip.
   * - `labels.seq IS NOT NULL` first, so a row the Server has already
   *   acknowledged is confirmed again unconditionally and a redelivered
   *   acknowledgement stays idempotent.
   * - Plain `=` on `updated_at`, where applyPulled needs `strftime`
   *   normalisation. Equality, not ordering, between the *same row* and a
   *   snapshot of itself taken when it was pushed — so both sides hold
   *   whatever string wrote it, byte for byte, and this is not a
   *   cross-writer comparison at all.
   *
   * No search index to re-derive here — Labels have none, unlike
   * SqliteTaskStore.applyAcknowledged's re-read/reindex step.
   */
  async applyAcknowledged(rows: readonly AcknowledgedLabel[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    for (const { confirmed, asPushed } of rows) {
      // withDefaultLabelColour — see upsert()'s own comment for why each
      // defaulter runs before the write.
      const normalized = withDefaultLabelColour(confirmed);
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
            updatedAt: sql`excluded.updated_at`,
            seq: sql`excluded.seq`,
            syncedAt: sql`excluded.synced_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
          setWhere: sql`${labels.seq} IS NOT NULL OR ${labels.updatedAt} = ${asPushed.updatedAt}`,
        });
    }
  }

  async rename(id: string, name: string): Promise<void> {
    assertValidLabelName(name);
    await this.updateIfLive(id, { name, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  async setColour(id: string, colour: string): Promise<void> {
    assertValidLabelColour(colour);
    await this.updateIfLive(id, { colour, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  /**
   * Tombstones a Label — never a hard delete (ADR 0028's rule). Blanks
   * `name` for the identical reason SqliteTaskStore.remove() blanks
   * `content`: a tombstone that still carried its old name would assert
   * "removed" and "still called X" about the same row at once.
   * `deletedAt`/`updatedAt` (issue #196) share one clock read — see
   * SqliteEntryStore.remove's identical comment for why.
   */
  async remove(id: string): Promise<void> {
    const deletedAt = this.now();
    await this.db
      .update(labels)
      .set({ deletedAt, name: "", updatedAt: deletedAt, seq: null, syncedAt: null })
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
