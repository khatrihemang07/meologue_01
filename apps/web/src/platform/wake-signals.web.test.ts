import { afterEach, describe, expect, it } from "vitest";
import { isTabVisible, subscribeToWakeEvents } from "./wake-signals.web";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

afterEach(() => {
  setVisibility("visible");
});

describe("isTabVisible", () => {
  it("reflects the document's visibility state", () => {
    setVisibility("visible");
    expect(isTabVisible()).toBe(true);

    setVisibility("hidden");
    expect(isTabVisible()).toBe(false);
  });
});

describe("subscribeToWakeEvents", () => {
  it("wakes when the tab becomes visible again", () => {
    let wakeCount = 0;
    subscribeToWakeEvents(() => {
      wakeCount++;
    });

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(wakeCount).toBe(1);
  });

  it("does not wake when the tab becomes hidden", () => {
    let wakeCount = 0;
    subscribeToWakeEvents(() => {
      wakeCount++;
    });

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(wakeCount).toBe(0);
  });

  it("wakes on window focus", () => {
    let wakeCount = 0;
    subscribeToWakeEvents(() => {
      wakeCount++;
    });

    window.dispatchEvent(new Event("focus"));

    expect(wakeCount).toBe(1);
  });

  it("wakes when the browser comes back online", () => {
    let wakeCount = 0;
    subscribeToWakeEvents(() => {
      wakeCount++;
    });

    window.dispatchEvent(new Event("online"));

    expect(wakeCount).toBe(1);
  });

  it("stops waking once unsubscribed", () => {
    let wakeCount = 0;
    const unsubscribe = subscribeToWakeEvents(() => {
      wakeCount++;
    });

    unsubscribe();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(wakeCount).toBe(0);
  });
});
