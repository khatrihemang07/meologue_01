/**
 * Thrown by the web target's sqlite-driver seam (`@/platform/sqlite-driver`)
 * when opening the SQLite store fails in a way the app must surface
 * explicitly rather than leave as a blank page (ticket 21). Kept
 * target-agnostic, in `lib` rather than `platform`, so `App.tsx` can
 * `instanceof`-check these regardless of which target's seam file ran.
 */

/** The OPFS pool VFS refused to install because another tab already holds it. */
export class SecondTabError extends Error {}

/** No usable storage in this browsing context — private browsing, or insecure origin. */
export class StorageUnavailableError extends Error {}
