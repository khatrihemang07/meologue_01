import type { EntryStore } from "@meologue/core";
import { getDeviceId } from "@/lib/device-id";
import { LocalEntryStore } from "@/lib/local-entry-store";

/**
 * Android's entry-store seam (ticket 21) — unchanged from before this
 * ticket: the browser-local store, wrapped as async to match the shared
 * signature. Gets its own real SQLite driver in a later ticket, at which
 * point only this file changes.
 */
export async function openEntryStore(): Promise<{ store: EntryStore; deviceId: string }> {
  return { store: new LocalEntryStore(), deviceId: getDeviceId() };
}
