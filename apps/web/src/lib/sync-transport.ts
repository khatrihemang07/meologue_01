import type { SyncTransport } from "@meologue/core";
import { useSettingsStore } from "@/lib/settings";

// The server's absolute address, exactly as stored in Settings (ADR 0008).
// Callers only invoke this once a Server URL is actually configured (ADR
// 0011 — Sync is opt-in, and the gate lives at the sync loop, not here).
export const syncTransport: SyncTransport = async (request) => {
  // Read per request, not hoisted to a local, so a Server URL saved between
  // two sync ticks takes effect on the next one without a restart.
  const url = useSettingsStore.getState().serverUrl;
  const response = await fetch(`${url}/v1/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    // A 426 specifically means `PROTOCOL_VERSION` (packages/core/src/
    // protocol.ts) is behind the Server's — ADR 0028's own bump from 1 to
    // 2, and ADR 0004's mechanism before it. That's not an ordinary
    // request failure: it's every future sync failing the same way until
    // this Device is updated, so it gets a sentence a reader can act on
    // instead of a bare status code. `server-check.ts`'s health check gates
    // `/v1/reflect` on the identical `PROTOCOL_VERSION` comparison, so an
    // out-of-date Device silently loses Reflection too — this message says
    // "meologue," not "Sync," so it doesn't imply Sync is the only thing
    // affected.
    if (response.status === 426) {
      throw new Error(
        "This Device's meologue is out of date and can no longer sync. Update or reinstall the app to continue.",
      );
    }
    throw new Error(`sync request failed with status ${response.status}`);
  }

  return response.json();
};
