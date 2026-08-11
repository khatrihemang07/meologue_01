import type { SyncTransport } from "@meologue/core";

export const syncTransport: SyncTransport = async (request) => {
  const response = await fetch("/v1/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`sync request failed with status ${response.status}`);
  }

  return response.json();
};
