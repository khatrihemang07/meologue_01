import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { digestAtTransport, digestTransport } from "./digest-transport";

const digestBody = {
  period: "day",
  period_start: "2026-08-20",
  period_end: "2026-08-20",
  body: "You wrote about your knee again today.",
  grounding_entry_ids: ["entry-1"],
  prev_date: "2026-08-18",
  next_date: null,
};

describe("digestTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("fetches the stored Server URL's /v1/digests/:period and returns the parsed Digest", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ digest: digestBody }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await digestTransport("day");

    expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/digests/day");
    expect(result).toEqual({ ok: true, digest: digestBody });
  });

  it("reports a 200 with digest: null as ok, with digest: null — not a failure", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ digest: null }) })),
    );

    const result = await digestTransport("day");

    expect(result).toEqual({ ok: true, digest: null });
  });

  it("reports a 404 (this Server has no Digest routes) as 'not-supported'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const result = await digestTransport("day");

    expect(result).toEqual({ ok: false, reason: "not-supported" });
  });

  it("reports a non-404 failure status as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await digestTransport("day");

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports a network failure (a thrown fetch) as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await digestTransport("day");

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ digest: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await digestTransport("week");

    useSettingsStore.getState().setServerUrl("https://second.example");
    await digestTransport("week");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://first.example/v1/digests/week");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://second.example/v1/digests/week");
  });
});

describe("digestAtTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("fetches the stored Server URL's /v1/digests/:period/:date and returns the parsed Digest", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ digest: digestBody }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await digestAtTransport("day", "2026-08-20");

    expect(fetchMock).toHaveBeenCalledWith("https://phone.example:41207/v1/digests/day/2026-08-20");
    expect(result).toEqual({ ok: true, digest: digestBody });
  });

  it("reports a 200 with digest: null as ok, with digest: null — not a failure", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ digest: null }) })),
    );

    const result = await digestAtTransport("day", "2026-08-20");

    expect(result).toEqual({ ok: true, digest: null });
  });

  it("reports a 404 (this Server has no Digest routes) as 'not-supported'", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const result = await digestAtTransport("day", "2026-08-20");

    expect(result).toEqual({ ok: false, reason: "not-supported" });
  });

  it("reports a non-404 failure status as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await digestAtTransport("day", "2026-08-20");

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports a network failure (a thrown fetch) as 'unreachable', without throwing", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await digestAtTransport("day", "2026-08-20");

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("re-reads the stored URL on every call, without re-importing the module", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ digest: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    useSettingsStore.getState().setServerUrl("https://first.example");
    await digestAtTransport("month", "2026-08-01");

    useSettingsStore.getState().setServerUrl("https://second.example");
    await digestAtTransport("month", "2026-08-01");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://first.example/v1/digests/month/2026-08-01",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://second.example/v1/digests/month/2026-08-01",
    );
  });
});
