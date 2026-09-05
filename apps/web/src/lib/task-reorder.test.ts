import type { Task } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { reorderedTaskDayOrder, reorderedTaskOrderKey, siblingMoveDropIndex } from "./task-reorder";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    deviceId: "device-a",
    content: "content",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    // Undated, no deadline, priority 1 ("no priority") — this
    // suite tests orderKey arithmetic, not scheduling, so the fixture
    // matches packages/core/src/test-support/task-fixture.ts's own default.
    date: null,
    deadline: null,
    priority: 1,
    // No Labels, doesn't repeat — the same "concrete value, not a gap"
    // default packages/core/src/test-support/task-fixture.ts's own
    // fixture uses for these two issue #170 fields.
    labelIds: [],
    dateString: null,
    // In Inbox, no Section, top-level — the same "nothing chosen yet"
    // state every other #171 field above defaults to, and what a Task
    // created directly in Todo starts with (@meologue/core's task-types.ts).
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
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

  it("moving a keyboard-reordered Task up or down and applying the result lands it where dragging would", () => {
    // The whole point of siblingMoveDropIndex (below): a keyboard move and
    // a pointer drag that land the same Task in the same slot must produce
    // the identical orderKey, because both go through this one function.
    const a = task({ id: "a", orderKey: "A" });
    const b = task({ id: "b", orderKey: "B" });
    const c = task({ id: "c", orderKey: "C" });
    const tasks = [a, b, c];

    // "c" moved up once should land strictly between "a" and "b" — the
    // same slot dragging "c" to index 1 already covers above.
    const upIndex = siblingMoveDropIndex(2, 3, "up");
    expect(upIndex).toBe(1);
    const upKey = reorderedTaskOrderKey(tasks, "c", upIndex as number);
    expect(upKey > "A").toBe(true);
    expect(upKey < "B").toBe(true);

    // "a" moved down once should land strictly between "b" and "c".
    const downIndex = siblingMoveDropIndex(0, 3, "down");
    expect(downIndex).toBe(1);
    const downKey = reorderedTaskOrderKey(tasks, "a", downIndex as number);
    expect(downKey > "B").toBe(true);
    expect(downKey < "C").toBe(true);
  });
});

// The Today-shaped sibling of the suite above (issue #182) — the identical
// arithmetic reused, not reinvented, over `dayOrder` instead of `orderKey`.
// Not a full re-run of every case above (reorderedKeyFor's own comment in
// task-reorder.ts is what guarantees the two share the identical
// computation) — this proves the second entry point reaches it and reads
// the right field, deliberately leaving `orderKey` at a value that would
// fail every assertion below if this function read the wrong column.
describe("reorderedTaskDayOrder", () => {
  it("sorts strictly between the two neighbours' dayOrders, ignoring their orderKeys", () => {
    const a = task({ id: "a", orderKey: "Z", dayOrder: "A" });
    const b = task({ id: "b", orderKey: "Y", dayOrder: "B" });
    const c = task({ id: "c", orderKey: "X", dayOrder: "C" });
    const tasks = [a, b, c];

    const key = reorderedTaskDayOrder(tasks, "c", 1);

    expect(key > "A").toBe(true);
    expect(key < "B").toBe(true);
  });

  it("ignores the dragged Task's own current position when finding its neighbours", () => {
    const a = task({ id: "a", dayOrder: "A" });
    const b = task({ id: "b", dayOrder: "B" });
    const c = task({ id: "c", dayOrder: "C" });

    const key = reorderedTaskDayOrder([a, b, c], "b", 0);

    expect(key < "A").toBe(true);
  });
});

describe("siblingMoveDropIndex", () => {
  it("returns null rather than a boundary index for the first sibling moving up", () => {
    expect(siblingMoveDropIndex(0, 3, "up")).toBeNull();
  });

  it("returns null rather than a boundary index for the last sibling moving down", () => {
    expect(siblingMoveDropIndex(2, 3, "down")).toBeNull();
  });

  it("returns null for the only sibling in either direction", () => {
    expect(siblingMoveDropIndex(0, 1, "up")).toBeNull();
    expect(siblingMoveDropIndex(0, 1, "down")).toBeNull();
  });

  it("moves a middle sibling one slot in either direction", () => {
    expect(siblingMoveDropIndex(1, 4, "up")).toBe(0);
    expect(siblingMoveDropIndex(1, 4, "down")).toBe(2);
  });
});
