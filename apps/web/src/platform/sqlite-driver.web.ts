import type { SqliteDriver } from "@meologue/core";
import { StorageUnavailableError } from "@/lib/entry-store-errors";
import { SqliteWorkerDriver } from "./sqlite-worker-driver";

/**
 * The web target's sqlite-driver seam (ticket 21, collapsed in ticket 24):
 * connects a SqliteDriver backed by the OPFS pool VFS, running in a
 * dedicated Worker (sqlite-worker.web.ts). Throws SecondTabError if another
 * tab already holds the OPFS pool, or StorageUnavailableError if there's no
 * usable storage here at all (insecure origin, private browsing) — the
 * caller (App.tsx) turns either into a visible message rather than a blank
 * page.
 */
export async function createDriver(): Promise<SqliteDriver> {
  // The OPFS pool VFS needs a secure context; check this before even
  // spinning up the worker, since it replaces what used to be a silent
  // blank page over plain HTTP to a non-localhost origin.
  if (!window.isSecureContext) {
    throw new StorageUnavailableError(
      "meologue needs a secure context (HTTPS or localhost) to store Entries.",
    );
  }

  const worker = new Worker(new URL("./sqlite-worker.web.ts", import.meta.url), {
    type: "module",
  });
  const driver = new SqliteWorkerDriver(worker);
  await driver.connect();
  return driver;
}
