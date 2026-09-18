import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearLastTodoView,
  lastTodoPath,
  readLastTodoView,
  writeLastTodoView,
} from "./last-todo-view";

describe("last-todo-view", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing has been remembered yet", () => {
    expect(readLastTodoView()).toBeNull();
  });

  it("round-trips every plain view", () => {
    for (const view of [
      "inbox",
      "today",
      "upcoming",
      "projects",
      "filters",
      "labels",
      "activity",
      "browse",
    ] as const) {
      writeLastTodoView({ view });
      expect(readLastTodoView()).toEqual({ view });
    }
  });

  it("round-trips a Project view with its id", () => {
    writeLastTodoView({ view: "project", projectId: "p1" });
    expect(readLastTodoView()).toEqual({ view: "project", projectId: "p1" });
  });

  it("round-trips a Filter view with its id", () => {
    writeLastTodoView({ view: "filter", filterId: "f1" });
    expect(readLastTodoView()).toEqual({ view: "filter", filterId: "f1" });
  });

  it("round-trips a Filter view with a null (still-unsaved) filterId", () => {
    writeLastTodoView({ view: "filter", filterId: null });
    expect(readLastTodoView()).toEqual({ view: "filter", filterId: null });
  });

  it("a later write replaces the earlier one, rather than accumulating", () => {
    writeLastTodoView({ view: "today" });
    writeLastTodoView({ view: "project", projectId: "p1" });
    expect(readLastTodoView()).toEqual({ view: "project", projectId: "p1" });
  });

  it("clear forgets the remembered view", () => {
    writeLastTodoView({ view: "today" });
    clearLastTodoView();
    expect(readLastTodoView()).toBeNull();
  });

  it("clear is a no-op when nothing was remembered", () => {
    expect(() => clearLastTodoView()).not.toThrow();
    expect(readLastTodoView()).toBeNull();
  });

  it("stores under a namespaced key, matching this codebase's other localStorage keys", () => {
    writeLastTodoView({ view: "today" });
    expect(localStorage.getItem("meologue.last-todo-view")).toBe(JSON.stringify({ view: "today" }));
  });

  it("degrades to null on a stored value that isn't JSON", () => {
    localStorage.setItem("meologue.last-todo-view", "not json{");
    expect(readLastTodoView()).toBeNull();
  });

  it("degrades to null on a stored value with an unrecognised view", () => {
    localStorage.setItem("meologue.last-todo-view", JSON.stringify({ view: "task-detail" }));
    expect(readLastTodoView()).toBeNull();
  });

  it("degrades to null on a stored Project view with a non-string projectId", () => {
    localStorage.setItem(
      "meologue.last-todo-view",
      JSON.stringify({ view: "project", projectId: 42 }),
    );
    expect(readLastTodoView()).toBeNull();
  });

  it("degrades to null on a stored Project view missing its projectId", () => {
    localStorage.setItem("meologue.last-todo-view", JSON.stringify({ view: "project" }));
    expect(readLastTodoView()).toBeNull();
  });

  it("degrades to null on a stored Filter view with a non-string, non-null filterId", () => {
    localStorage.setItem(
      "meologue.last-todo-view",
      JSON.stringify({ view: "filter", filterId: 7 }),
    );
    expect(readLastTodoView()).toBeNull();
  });

  it("degrades to null on a stored value that isn't an object", () => {
    localStorage.setItem("meologue.last-todo-view", JSON.stringify("today"));
    expect(readLastTodoView()).toBeNull();
  });

  // localStorage throws on write in some privacy modes (Safari private
  // browsing) and can throw on read too — settings.ts and last-session.ts
  // both document the same hazard. Todo must not break just because this
  // convenience couldn't be kept, so every operation degrades silently.
  it("degrades to null on a read that throws, rather than throwing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      expect(readLastTodoView()).toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      }
    }
  });

  it("swallows a write that throws, rather than throwing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      expect(() => writeLastTodoView({ view: "today" })).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      }
    }
  });

  it("swallows a clear that throws, rather than throwing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      expect(() => clearLastTodoView()).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      }
    }
  });

  describe("lastTodoPath", () => {
    it("falls back to /todo/inbox when nothing is remembered", () => {
      expect(lastTodoPath()).toBe("/todo/inbox");
    });

    it("falls back to /todo/inbox on a corrupt stored value", () => {
      localStorage.setItem("meologue.last-todo-view", "not json{");
      expect(lastTodoPath()).toBe("/todo/inbox");
    });

    it("resolves every plain view to its own address", () => {
      for (const view of [
        "inbox",
        "today",
        "upcoming",
        "projects",
        "filters",
        "labels",
        "activity",
        "browse",
      ] as const) {
        writeLastTodoView({ view });
        expect(lastTodoPath()).toBe(`/todo/${view}`);
      }
    });

    it("resolves a Project view to that Project's own address", () => {
      writeLastTodoView({ view: "project", projectId: "p1" });
      expect(lastTodoPath()).toBe("/todo/projects/p1");
    });

    it("resolves a Filter view to that Filter's own address", () => {
      writeLastTodoView({ view: "filter", filterId: "f1" });
      expect(lastTodoPath()).toBe("/todo/filters/f1");
    });

    it("resolves a still-unsaved Filter view to /todo/filters/new", () => {
      writeLastTodoView({ view: "filter", filterId: null });
      expect(lastTodoPath()).toBe("/todo/filters/new");
    });
  });
});
