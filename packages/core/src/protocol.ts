/**
 * Mirrors the server's constants (server/src/sync.rs) — not generated, since
 * they aren't part of the OpenAPI schema. Keep in sync by hand.
 */
// 6, not 5: issue #182 / ADR 0051 widened SyncRequest/SyncResponse a second
// time, with four more entity streams (Projects, Sections, Labels, Comments
// — ADR 0047's remaining root nouns plus #180's Comment), alongside Entries
// and Tasks. See server/src/sync.rs's own PROTOCOL_VERSION doc comment for
// the bump's reasoning and for MIN_PROTOCOL_VERSION, the Server-side detail
// that has no client-side mirror: the Server accepts 4, 5 and 6 for one
// release, so a Device still shipping this constant at 4 or 5 keeps syncing
// Entries and Tasks unaffected and simply never sees a Project, Section,
// Label or Comment.
export const PROTOCOL_VERSION = 6;
export const SYNC_BATCH_SIZE = 500;

/** The continuous-sync poll interval — "a few seconds" is the agreed bar for "live". */
export const SYNC_INTERVAL_MS = 5000;
