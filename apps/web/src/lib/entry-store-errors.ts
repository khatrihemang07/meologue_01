/**
 * Thrown by the web target's sqlite-driver seam (`@/platform/sqlite-driver`)
 * when opening the SQLite store fails in a way the app must surface
 * explicitly rather than leave as a blank page (ticket 21). Kept
 * target-agnostic, in `lib` rather than `platform`, so `App.tsx` can
 * `instanceof`-check these regardless of which target's seam file ran.
 */

/** The OPFS pool VFS refused to install because another tab already holds it. */
export class SecondTabError extends Error {}

/** The browser refused a legitimate attempt to open OPFS — private browsing, quota, an engine quirk. */
export class StorageUnavailableError extends Error {}

/**
 * This origin can never have OPFS, so no attempt was made: the page is on
 * plain HTTP to something other than `localhost`, and browsers gate OPFS
 * behind a secure context (ADR 0017).
 *
 * Deliberately a sibling of `StorageUnavailableError` rather than a subclass
 * of it. The two differ in the only way that matters to a reader: this one is
 * fixable from where they are standing — open the same app on an HTTPS origin
 * and it works — where `StorageUnavailableError` means the browser turned down
 * an attempt that should have succeeded, and mostly isn't theirs to fix. A
 * subclass would also make `describeOpenError`'s `instanceof` chain silently
 * order-dependent: check the parent first and this branch never fires.
 */
export class InsecureContextError extends Error {}

/**
 * The worker backing the web target's SqliteDriver (`sqlite-worker.web.ts`)
 * failed outside its own try/catch — a `error` or `messageerror` event on
 * the `Worker` object itself, not an `open` response it deliberately posted
 * (issue #159). This means the worker script never got far enough to even
 * attempt an open: it failed to load, threw at module top level, or posted
 * something `SqliteWorkerDriver` couldn't deserialize. Kept distinct from
 * `StorageUnavailableError` because the two causes call for different
 * debugging: `StorageUnavailableError` means OPFS itself refused a
 * legitimate attempt; `WorkerLoadError` means the attempt never happened.
 */
export class WorkerLoadError extends Error {}

/**
 * `SqliteWorkerDriver.connect()` (`sqlite-worker-driver.ts`) never received
 * an `open` response within its timeout (issue #159). Deliberately its own
 * class rather than folded into `StorageUnavailableError`: nothing has
 * actually failed as far as this Device can tell — the worker may still be
 * working (a cold OPFS pool install is not instant) or may be stuck
 * forever, and there is no way to distinguish those from outside the
 * worker. The point of this class existing is so a reader sees "this is
 * taking longer than expected" rather than either silence or a flat,
 * possibly-false "failed."
 */
export class OpenTimeoutError extends Error {}
