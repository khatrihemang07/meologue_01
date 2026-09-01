import type { Task } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { reorderedTaskOrderKey } from "./task-reorder";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    deviceId: "device-a",
    content: "content",
    completedAt: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    // Undated, no deadline, no duration, priority 1 ("no priority") — this
    // suite tests orderKey arithmetic, not scheduling, so the fixture
    // matches packages/core/src/test-support/task-fixture.ts's own default.
    date: null,
    deadline: null,
    duration: null,
    priority: 1,
    ...overrides,
  };
}

describe("reorderedTaskOrderKey", () => {
  it("sorts strictly between the two neighbours at the drop position", () => {
    const a = task({ id: "a", orderKey: "A" });
    const b = task({ id: "b", orderKey: "B" });
    const c = task({ id: "c", orderKey: "C" });
    const tasks = [a, b, c];

    // Dragging "c" to land between "a" and "b" — index 1 in the
    // without-"c" list [a, b].
    const key = reorderedTaskOrderKey(tasks, "c", 1);

    expect(key > "A").toBe(true);
    expect(key < "B").toBe(true);
  });

  it("sorts before every sibling when dropped at index 0", () => {
    const a = task({ id: "a", orderKey: "A" });
    const b = task({ id: "b", orderKey: "B" });

    const key = reorderedTaskOrderKey([a, b], "b", 0);

    expect(key < "A").toBe(true);
  });

  it("sorts after every sibling when dropped past the end", () => {
    const a = task({ id: "a", orderKey: "A" });
    const b = task({ id: "b", orderKey: "B" });

    const key = reorderedTaskOrderKey([a, b], "a", 2);

    expect(key > "B").toBe(true);
  });

  it("ignores the dragged Task's own current position when finding its neighbours", () => {
    // "b" sits between "a" and "c" today; dropping it back at index 0 (the
    // very start) must be computed against [a, c] with "b" removed, not
    // against the original three — a naive index into the un-filtered list
    // would land the new key between "a" and "b" instead of before "a".
    const a = task({ id: "a", orderKey: "A" });
    const b = task({ id: "b", orderKey: "B" });
    const c = task({ id: "c", orderKey: "C" });

    const key = reorderedTaskOrderKey([a, b, c], "b", 0);

    expect(key < "A").toBe(true);
  });

  it("clamps an out-of-range drop index rather than throwing", () => {
    const a = task({ id: "a", orderKey: "A" });

    expect(() => reorderedTaskOrderKey([a], "a", -5)).not.toThrow();
    expect(() => reorderedTaskOrderKey([a], "a", 99)).not.toThrow();
  });
});
