import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatus, useSyncStatusStore } from "@/lib/sync-status";

const URL_A = "https://server-a.example";
const URL_B = "https://server-b.example";

describe("useSyncStatus", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("is off with no Server URL configured, regardless of any recorded attempt", () => {
    useSyncStatusStore.getState().recordFailure(URL_A, "boom");

    const { result } = renderHook(() => useSyncStatus());

    expect(result.current).toEqual({ state: "off" });
  });

  it("is working once a Server URL is configured with no attempt recorded yet", () => {
    useSettingsStore.setState({ serverUrl: URL_A });

    const { result } = renderHook(() => useSyncStatus());

    expect(result.current).toEqual({ state: "working" });
  });

  it("is working after a successful attempt", () => {
    useSettingsStore.setState({ serverUrl: URL_A });
    useSyncStatusStore.getState().recordSuccess(URL_A);

    const { result } = renderHook(() => useSyncStatus());

    expect(result.current).toEqual({ state: "working" });
  });

  it("is failing, with the recorded reason, after a failed attempt", () => {
    useSettingsStore.setState({ serverUrl: URL_A });
    useSyncStatusStore.getState().recordFailure(URL_A, "sync request failed with status 500");

    const { result } = renderHook(() => useSyncStatus());

    expect(result.current).toEqual({
      state: "failing",
      reason: "sync request failed with status 500",
    });
  });

  it("recovers from a failure the moment a later attempt succeeds, with no reload", () => {
    useSettingsStore.setState({ serverUrl: URL_A });
    useSyncStatusStore.getState().recordFailure(URL_A, "boom");
    const { result, rerender } = renderHook(() => useSyncStatus());
    expect(result.current.state).toBe("failing");

    useSyncStatusStore.getState().recordSuccess(URL_A);
    rerender();

    expect(result.current).toEqual({ state: "working" });
  });

  it("does not carry a failure recorded against a previous Server URL over to a new one", () => {
    useSyncStatusStore.getState().recordFailure(URL_A, "boom");
    useSettingsStore.setState({ serverUrl: URL_B });

    const { result } = renderHook(() => useSyncStatus());

    expect(result.current).toEqual({ state: "working" });
  });

  it("turns off, and drops a prior failure, when the Server URL is cleared", () => {
    useSettingsStore.setState({ serverUrl: URL_A });
    useSyncStatusStore.getState().recordFailure(URL_A, "boom");
    const { result, rerender } = renderHook(() => useSyncStatus());
    expect(result.current.state).toBe("failing");

    useSettingsStore.setState({ serverUrl: "" });
    rerender();

    expect(result.current).toEqual({ state: "off" });
  });
});
