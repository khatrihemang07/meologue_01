import type { SyncTransport } from "@meologue/core";

// The server's absolute address, injected at build time via `VITE_SERVER_URL`
// (see ADR 0006). Empty by default, so this stays the same relative request
// it always was — same-origin, no host the client had to learn.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "";

export const syncTransport: SyncTransport = async (request) => {
  const response = await fetch(`${SERVER_URL}/v1/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`sync request failed with status ${response.status}`);
  }

  return response.json();
};
