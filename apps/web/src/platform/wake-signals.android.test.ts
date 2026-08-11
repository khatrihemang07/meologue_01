import { describe, expect, it } from "vitest";
import { isTabVisible, subscribeToWakeEvents } from "./wake-signals.android";

describe("isTabVisible (android placeholder)", () => {
  it("reports visible, since there is no real signal yet", () => {
    expect(isTabVisible()).toBe(true);
  });
});

describe("subscribeToWakeEvents (android placeholder)", () => {
  it("never wakes, and returns a no-op unsubscribe", () => {
    let wakeCount = 0;
    const unsubscribe = subscribeToWakeEvents(() => {
      wakeCount++;
    });

    expect(() => unsubscribe()).not.toThrow();
    expect(wakeCount).toBe(0);
  });
});
