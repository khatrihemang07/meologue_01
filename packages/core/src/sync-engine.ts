import {
  fromWireEntryOutput,
  fromWireTaskOutput,
  toWireEntryInput,
  toWireTaskInput,
} from "./mapping";
import { PROTOCOL_VERSION, SYNC_BATCH_SIZE } from "./protocol";
import type { EntryStore } from "./store";
import type { TaskStore } from "./task-store";
import type { WireSyncRequest, WireSyncResponse } from "./wire";

export type SyncTransport = (request: WireSyncRequest) => Promise<WireSyncResponse>;

export interface SyncEngineOptions {
  store: EntryStore;
  /**
   * Issue #172 / ADR 0051: Sync's second entity stream, alongside `store`
   * above. Required, not optional — every real caller already has one
   * (ADR 0047's Consequences: `TaskStore` sits over the identical shared
   * `SqliteDriver` an `EntryStore` does, opened once, in the same place),
   * and an optional field here would let a future caller quietly build a
   * Sync loop that pushes and pulls Entries while silently never touching
   * Tasks — the exact kind of drift ADR 0051's "one endpoint, one round
   * trip" decision exists to rule out structurally rather than by
   * convention.
   */
  taskStore: TaskStore;
  transport: SyncTransport;
  deviceId: string;
  /** Injected so tests can control the timestamp recorded as syncedAt. */
  now?: () => string;
}

/**
 * Runs push and pull as a single loop: pending Entries **and** pending
 * Tasks go out in the same request, everything that comes back (including
 * this Device's own, now-confirmed rows) is upserted into its own store,
 * and both Cursors advance — one endpoint, one round trip (ADR 0051), so a
 * Task and the Entry referencing it always arrive together rather than
 * leaving a window where one exists on this Device and the other doesn't
 * yet. Repeats immediately while *either* stream's response batch is full,
 * since a full batch on either one means there's more of *that* stream
 * waiting on the server — the next request re-pushes nothing new for the
 * already-drained stream (its `pending()` is empty by then) and simply
 * keeps paging the other one forward.
 */
export async function sync(options: SyncEngineOptions): Promise<void> {
  const { store, taskStore, transport, deviceId } = options;
  const now = options.now ?? (() => new Date().toISOString());

  let batchWasFull = true;
  while (batchWasFull) {
    const [pending, cursor, pendingTasks, taskCursor] = await Promise.all([
      store.pending(),
      store.getCursor(),
      taskStore.pending(),
      taskStore.getCursor(),
    ]);

    const response = await transport({
      protocol_version: PROTOCOL_VERSION,
      device_id: deviceId,
      since_seq: cursor,
      entries: pending.map(toWireEntryInput),
      since_task_seq: taskCursor,
      tasks: pendingTasks.map(toWireTaskInput),
    });

    if (response.entries.length > 0) {
      const syncedAt = now();
      await store.upsert(response.entries.map((entry) => fromWireEntryOutput(entry, syncedAt)));
    }
    if (response.cursor > cursor) {
      await store.setCursor(response.cursor);
    }

    if (response.tasks.length > 0) {
      const syncedAt = now();
      await taskStore.upsert(response.tasks.map((task) => fromWireTaskOutput(task, syncedAt)));
    }
    if (response.task_cursor > taskCursor) {
      await taskStore.setCursor(response.task_cursor);
    }

    batchWasFull =
      response.entries.length >= SYNC_BATCH_SIZE || response.tasks.length >= SYNC_BATCH_SIZE;
  }
}
