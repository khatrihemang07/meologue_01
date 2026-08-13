import type { EntryStore } from "@meologue/core";
import { getDeviceId } from "@/lib/device-id";
import { LocalEntryStore } from "@/lib/local-entry-store";

/**
 * macOS's entry-store seam — unchanged from ticket 21: the browser-local
 * store, wrapped as async to match the shared signature. Used to reuse
 * entry-store.android.ts (identical at the time), but ticket 22 moved
 * Android onto its own real SQLite driver, so that file no longer
 * describes macOS's behaviour; this now stands alone until macOS gets its
 * own SQLite driver in a later ticket.
 */
export async function openEntryStore(): Promise<{ store: EntryStore; deviceId: string }> {
  return { store: new LocalEntryStore(), deviceId: getDeviceId() };
}
