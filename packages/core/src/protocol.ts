/**
 * Mirrors the server's constants (server/src/sync.rs) — not generated, since
 * they aren't part of the OpenAPI schema. Keep in sync by hand.
 */
export const PROTOCOL_VERSION = 2;
export const SYNC_BATCH_SIZE = 500;

/** The continuous-sync poll interval — "a few seconds" is the agreed bar for "live". */
export const SYNC_INTERVAL_MS = 5000;
