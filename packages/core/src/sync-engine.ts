import { fromWireEntryOutput, toWireEntryInput } from "./mapping";
import { PROTOCOL_VERSION, SYNC_BATCH_SIZE } from "./protocol";
import type { EntryStore } from "./store";
import type { WireSyncRequest, WireSyncResponse } from "./wire";

export type SyncTransport = (request: WireSyncRequest) => Promise<WireSyncResponse>;

export interface SyncEngineOptions {
  store: EntryStore;
  transport: SyncTransport;
  deviceId: string;
  /** Injected so tests can control the timestamp recorded as syncedAt. */
  now?: () => string;
}

/**
 * Runs push and pull as a single loop: pending Entries go out, everything
 * that comes back (including this Device's own, now-confirmed Entries) is
 * upserted, and the Cursor advances. Repeats immediately while the response
 * batch is full, since a full batch means there's more waiting on the server.
 */
export async function sync(options: SyncEngineOptions): Promise<void> {
  const { store, transport, deviceId } = options;
  const now = options.now ?? (() => new Date().toISOString());

  let batchWasFull = true;
  while (batchWasFull) {
    const [pending, cursor] = await Promise.all([store.pending(), store.getCursor()]);

    const response = await transport({
      protocol_version: PROTOCOL_VERSION,
      device_id: deviceId,
      since_seq: cursor,
      entries: pending.map(toWireEntryInput),
    });

    if (response.entries.length > 0) {
      const syncedAt = now();
      await store.upsert(response.entries.map((entry) => fromWireEntryOutput(entry, syncedAt)));
    }

    if (response.cursor > cursor) {
      await store.setCursor(response.cursor);
    }

    batchWasFull = response.entries.length >= SYNC_BATCH_SIZE;
  }
}
