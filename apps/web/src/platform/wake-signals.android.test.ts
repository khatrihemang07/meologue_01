import type { AppState } from "@capacitor/app";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StateChangeListener = (state: AppState) => void;

let stateChangeListener: StateChangeListener | undefined;
const removeMock = vi.fn();

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn((_eventName: string, listener: StateChangeListener) => {
      stateChangeListener = listener;
      return Promise.resolve({ remove: removeMock });
    }),
  },
}));

describe("wake-signals.android", () => {
  beforeEach(() => {
    vi.resetModules();
    stateChangeListener = undefined;
    removeMock.mockClear();
  });

  it("reports visible before any lifecycle event arrives, since the app launches in the foreground", async () => {
    const { isTabVisible } = await import("./wake-signals.android");
    expect(isTabVisible()).toBe(true);
  });

  it("wakes and reports invisible when the app is backgrounded, then visible again on resume", async () => {
    const { isTabVisible, subscribeToWakeEvents } = await import("./wake-signals.android");
    let wakeCount = 0;
    subscribeToWakeEvents(() => {
      wakeCount++;
    });

    stateChangeListener?.({ isActive: false });
    expect(isTabVisible()).toBe(false);
    expect(wakeCount).toBe(0);

    stateChangeListener?.({ isActive: true });
    expect(isTabVisible()).toBe(true);
    expect(wakeCount).toBe(1);
  });

  it("removes the native listener on unsubscribe", async () => {
    const { subscribeToWakeEvents } = await import("./wake-signals.android");
    const unsubscribe = subscribeToWakeEvents(() => {});

    unsubscribe();
    await Promise.resolve();

    expect(removeMock).toHaveBeenCalledOnce();
  });
});
