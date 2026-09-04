import { desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { EventStore } from "../event-store";
import type { Event } from "../event-types";
import type { SqliteDriver } from "./driver";
import { events, kv } from "./schema";

/**
 * The SQLite-backed EventStore (issue #184) — mirrors SqliteCommentStore
 * (./sqlite-comment-store.ts) closely enough that a reader of one
 * recognises the other, with the mutation-shaped members
 * (`edit()`/`remove()`/tombstone handling) dropped rather than left as
 * unreachable no-ops — see ../event-store.ts's own header comment for
 * why. See ./open.ts rather than this constructor directly: `events`
 * (migration 15) has to exist before this can query it.
 */
export class SqliteEventStore implements EventStore {
  private readonly db: ReturnType<typeof drizzle>;

  constructor(driver: SqliteDriver) {
    this.db = drizzle((sqlText, params, method) => driver.execute(sqlText, params, method));
  }

  async list(): Promise<Event[]> {
    return this.db
      .select()
      .from(events)
      .orderBy(desc(events.occurredAt), desc(events.id)) as Promise<Event[]>;
  }

  async listByTask(taskId: string): Promise<Event[]> {
    return this.db
      .select()
      .from(events)
      .where(eq(events.taskId, taskId))
      .orderBy(desc(events.occurredAt), desc(events.id)) as Promise<Event[]>;
  }

  async listByProject(projectId: string | null): Promise<Event[]> {
    return this.db
      .select()
      .from(events)
      .where(projectId === null ? isNull(events.projectId) : eq(events.projectId, projectId))
      .orderBy(desc(events.occurredAt), desc(events.id)) as Promise<Event[]>;
  }

  // Single-row write path for a locally-recorded act — see
  // ../event-store.ts's own `record()` doc comment for why this is a
  // distinct method from `upsert()` below rather than the same door.
  // `onConflictDoNothing` even here, though a genuine local `record()`
  // call should never collide with an existing id (mintId()'s own
  // collision-freedom guarantee) — cheap insurance against a caller
  // retrying the same write, mirroring `upsert()`'s own dedup rule below
  // rather than assuming it can never matter.
  async record(event: Event): Promise<void> {
    await this.db.insert(events).values(event).onConflictDoNothing();
  }

  // Sync's pull-side write path — bulk, and **overwrites** on conflict,
  // unlike record() above. See ../event-store.ts's own `upsert()` doc
  // comment for why this is the correct behaviour and not a violation of
  // "an Event is never rewritten": the one case this must overwrite for
  // is the echo of this Device's own pending push confirming its `seq`,
  // and every other case is an overwrite with identical content, since
  // an id's content never legitimately differs between two calls.
  async upsert(newEvents: Event[]): Promise<void> {
    if (newEvents.length === 0) {
      return;
    }
    await this.db
      .insert(events)
      .values(newEvents)
      .onConflictDoUpdate({
        target: events.id,
        set: {
          deviceId: sql`excluded.device_id`,
          eventType: sql`excluded.event_type`,
          objectType: sql`excluded.object_type`,
          objectId: sql`excluded.object_id`,
          taskId: sql`excluded.task_id`,
          projectId: sql`excluded.project_id`,
          occurredAt: sql`excluded.occurred_at`,
          extra: sql`excluded.extra`,
          seq: sql`excluded.seq`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }

  async pending(): Promise<Event[]> {
    return this.db.select().from(events).where(isNull(events.seq)) as Promise<Event[]>;
  }

  async getCursor(): Promise<number> {
    const value = await this.getKv(EVENT_CURSOR_KEY);
    return value === undefined ? 0 : Number(value);
  }

  async setCursor(seq: number): Promise<void> {
    await this.setKv(EVENT_CURSOR_KEY, String(seq));
  }

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for the mechanism. Unexercised today (no field
  // has ever been added to an existing Event shape — EventStore's own
  // doc comment on why), but wired in now for the identical reason this
  // store already carries seq/pending()/a Cursor ahead of ever needing
  // them: free to build in, a real migration-shaped retrofit later.
  async catchUpRowShapeEpoch(currentEpoch: number): Promise<void> {
    const stored = await this.getKv(EVENT_ROW_SHAPE_EPOCH_KEY);
    const storedEpoch = stored === undefined ? 0 : Number(stored);
    if (storedEpoch >= currentEpoch) {
      return;
    }
    await this.setCursor(0);
    await this.setKv(EVENT_ROW_SHAPE_EPOCH_KEY, String(currentEpoch));
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

const EVENT_CURSOR_KEY = "event_cursor";

// Issue #186 / ADR 0057: the Event stream's own row-shape-epoch key.
const EVENT_ROW_SHAPE_EPOCH_KEY = "event_row_shape_epoch";
