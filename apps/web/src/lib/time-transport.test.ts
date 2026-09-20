import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { type ActivityInterval, listActivityIntervals, listTimeSources } from "./time-transport";

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
});
