import type { SyncTransport } from "@meologue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncTransport } from "./sync-transport";

const request: Parameters<SyncTransport>[0] = {
  protocol_version: 1,
  device_id: "device-1",
  since_seq: 0,
  entries: [],
};

describe("syncTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the request to /v1/sync and returns the parsed response", async () => {
    const responseBody = { entries: [], cursor: 3 };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => responseBody }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncTransport(request);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    expect(result).toEqual(responseBody);
  });

  it("throws when the server responds with a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 426, json: async () => ({}) })),
    );

    await expect(syncTransport(request)).rejects.toThrow();
  });
});
