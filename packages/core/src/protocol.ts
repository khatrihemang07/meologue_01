/**
 * Mirrors the server's constants (server/src/sync.rs) — not generated, since
 * they aren't part of the OpenAPI schema. Keep in sync by hand.
 */
// 5, not 4: issue #172 / ADR 0051 widened SyncRequest/SyncResponse with a
// second entity stream (Tasks, alongside Entries). See server/src/sync.rs's
// own PROTOCOL_VERSION doc comment for the bump's reasoning and for
// MIN_PROTOCOL_VERSION, the Server-side detail that has no client-side
// mirror: the Server accepts both 4 and 5 for one release, so a Device
// still shipping this constant at 4 keeps syncing Entries unaffected and
// simply never sees a Task.
export const PROTOCOL_VERSION = 5;
export const SYNC_BATCH_SIZE = 500;

/** The continuous-sync poll interval — "a few seconds" is the agreed bar for "live". */
export const SYNC_INTERVAL_MS = 5000;
