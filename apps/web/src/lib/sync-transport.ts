import type { SyncTransport } from "@meologue/core";
import { readServerUrl } from "@/lib/settings";

// The server's absolute address: a runtime Settings override if one is
// stored, else the build-time `VITE_SERVER_URL` (see ADR 0008, which
// supersedes ADR 0006). Empty by default either way, so this stays the
// same relative request it always was — same-origin, no host the client
// had to learn.
export const syncTransport: SyncTransport = async (request) => {
  // Read per request, not hoisted to module scope, so a Server URL saved
  // between two sync ticks takes effect on the next one without a restart.
  const url = readServerUrl() || import.meta.env.VITE_SERVER_URL || "";
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
