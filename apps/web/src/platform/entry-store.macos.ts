/**
 * macOS's entry-store seam (ticket 21) is identical to Android's today —
 * both keep the browser-local store unchanged, each getting a real SQLite
 * driver in its own later ticket — so this reuses that file rather than
 * duplicating it, matching wake-signals.macos.ts's precedent.
 */
export { openEntryStore } from "./entry-store.android";
