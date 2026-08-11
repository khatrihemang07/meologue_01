import type { Entry } from "@meologue/core";
import { sync } from "@meologue/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getDeviceId } from "@/lib/device-id";
import { normalizeEntryBody } from "@/lib/entry-text";
import { LocalEntryStore } from "@/lib/local-entry-store";
import { syncTransport } from "@/lib/sync-transport";

export interface UseHistoryResult {
  entries: Entry[];
  sendEntry: (raw: string) => void;
}

/**
 * Owns this Device's History: the browser-local store, its id, and the
 * on-demand sync engine wired to the server. An Entry renders from the local
 * write immediately; sync runs afterward and again silently refreshes the
 * view once anything changes.
 */
export function useHistory(): UseHistoryResult {
  const store = useMemo(() => new LocalEntryStore(), []);
  const deviceId = useMemo(() => getDeviceId(), []);
  const [entries, setEntries] = useState<Entry[]>([]);

  const refresh = useCallback(async () => {
    setEntries(await store.list());
  }, [store]);

  const runSync = useCallback(async () => {
    await sync({ store, transport: syncTransport, deviceId });
    await refresh();
  }, [store, deviceId, refresh]);

  useEffect(() => {
    void (async () => {
      await refresh();
      try {
        await runSync();
      } catch (error) {
        console.error("meologue: startup sync failed", error);
      }
    })();
  }, [refresh, runSync]);

  const sendEntry = useCallback(
    (raw: string) => {
      const body = normalizeEntryBody(raw);
      if (body === null) {
        return;
      }

      const entry: Entry = {
        id: crypto.randomUUID(),
        deviceId,
        body,
        createdAt: new Date().toISOString(),
        seq: null,
        syncedAt: null,
      };

      void (async () => {
        await store.upsert([entry]);
        await refresh();

        try {
          await runSync();
        } catch (error) {
          console.error("meologue: sync failed", error);
        }
      })();
    },
    [deviceId, store, refresh, runSync],
  );

  return { entries, sendEntry };
}
