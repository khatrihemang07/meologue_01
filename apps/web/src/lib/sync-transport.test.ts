import type { SyncTransport } from "@meologue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
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
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("posts the request to the stored Server URL's /v1/sync and returns the parsed response", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const responseBody = { entries: [], cursor: 3 };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => responseBody }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncTransport(request);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://phone.example:41207/v1/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    expect(result).toEqual(responseBody);
  });

  it("throws when the server responds with a non-2xx status", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    await expect(syncTransport(request)).rejects.toThrow("sync request failed with status 500");
  });

  // ADR 0028: PROTOCOL_VERSION moved from 1 to 2, and a 426 specifically
  // means this Device is behind the Server's — a message worth a reader's
  // attention (Settings surfaces `error.message` verbatim as the
  // sync-failure reason), not a bare status code.
  it("maps a 426 to a human sentence naming the Device as out of date", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 426, json: async () => ({}) })),
    );

    await expect(syncTransport(request)).rejects.toThrow(/out of date/i);
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const responseBody = { entries: [], cursor: 0 };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => responseBody }));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await syncTransport(request);

    useSettingsStore.getState().setServerUrl("https://second.example");
    await syncTransport(request);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://first.example/v1/sync",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://second.example/v1/sync",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
