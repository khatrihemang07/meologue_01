import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLastSessionId, readLastSessionId, writeLastSessionId } from "./last-session";

describe("last-session", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("returns null when nothing has been remembered yet", () => {
    expect(readLastSessionId()).toBeNull();
  });

  it("returns what was last written", () => {
    writeLastSessionId("session-1");
    expect(readLastSessionId()).toBe("session-1");
  });

  it("a later write replaces the earlier one, rather than accumulating", () => {
    writeLastSessionId("session-1");
    writeLastSessionId("session-2");
    expect(readLastSessionId()).toBe("session-2");
  });

  it("clear forgets the remembered id", () => {
    writeLastSessionId("session-1");
    clearLastSessionId();
    expect(readLastSessionId()).toBeNull();
  });

  it("clear is a no-op when nothing was remembered", () => {
    expect(() => clearLastSessionId()).not.toThrow();
    expect(readLastSessionId()).toBeNull();
  });

  it("stores under a namespaced key, matching this codebase's other sessionStorage backup", () => {
    writeLastSessionId("session-1");
    expect(sessionStorage.getItem("meologue.last-session-id")).toBe("session-1");
  });

  // sessionStorage throws on write in some privacy modes (Safari private
  // browsing) and can throw on read too (e.g. a security exception in some
  // embedding contexts) — settings.ts documents the same hazard for
  // localStorage. Reflection must not break just because this convenience
  // couldn't be kept, so every operation degrades silently instead.
  it("degrades to null on a read that throws, rather than throwing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      expect(readLastSessionId()).toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(window, "sessionStorage", original);
      }
    }
  });

  it("swallows a write that throws, rather than throwing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      expect(() => writeLastSessionId("session-1")).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(window, "sessionStorage", original);
      }
    }
  });

  it("swallows a clear that throws, rather than throwing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      expect(() => clearLastSessionId()).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(window, "sessionStorage", original);
      }
    }
  });
});
