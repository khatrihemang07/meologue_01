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
    throw new Error(`sync request failed with status ${response.status}`);
  }

  return response.json();
};
