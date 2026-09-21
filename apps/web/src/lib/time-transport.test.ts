import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import {
  type ActivityInterval,
  listActivityIntervals,
  listTimeSources,
  updateTimeSource,
} from "./time-transport";

describe("Time transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useSettingsStore.setState({ serverUrl: "" });
  });

  it("requests the enabled Time sources from the configured Server", async () => {
    useSettingsStore.getState().setServerUrl("https://time.example");
    const sources = [
      {
        id: "toggl",
        name: "Toggl",
        kind: "toggl_activity",
        path: "/tmp/toggl.sqlite",
        enabled: true,
      },
    ];
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => sources }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listTimeSources()).resolves.toEqual({ ok: true, sources });
    expect(fetchMock).toHaveBeenCalledWith("https://time.example/v1/time/sources");
  });

  // Since issue #420 a day is fetched once across every source rather than
  // once per source: each interval carries its own source attribution, so one
  // request is enough to build every lane.
  it("asks for a whole day rather than one source's slice of it", async () => {
    useSettingsStore.getState().setServerUrl("https://time.example");
    const intervals: ActivityInterval[] = [];
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => intervals }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listActivityIntervals("2026-09-20")).resolves.toEqual({
      ok: true,
      intervals,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://time.example/v1/time/intervals?day=2026-09-20");
  });

  it("reads a 404 on the source route as a Server that cannot do this", async () => {
    // Two different things answer 404 here — a Server that predates Time, and
    // a source that is gone — and neither leaves this Device anything to do,
    // so both collapse into one reason rather than a distinction no caller
    // could act on.
    useSettingsStore.getState().setServerUrl("https://time.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    await expect(updateTimeSource("gone", { enabled: false })).resolves.toEqual({
      ok: false,
      reason: "not-supported",
    });
  });

  it("reports an unreachable Server separately from one that refused", async () => {
    useSettingsStore.getState().setServerUrl("https://time.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(updateTimeSource("toggl", { enabled: true })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
