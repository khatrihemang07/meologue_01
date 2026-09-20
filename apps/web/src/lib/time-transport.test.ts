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

  it("scopes a daily interval request to its selected source", async () => {
    useSettingsStore.getState().setServerUrl("https://time.example");
    const intervals: ActivityInterval[] = [];
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => intervals }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listActivityIntervals("2026-09-20", "toggl")).resolves.toEqual({
      ok: true,
      intervals,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://time.example/v1/time/intervals?day=2026-09-20&source_id=toggl",
    );
  });
});
