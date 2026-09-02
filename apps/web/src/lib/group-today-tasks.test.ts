import type { Task } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { groupTodayTasks } from "./group-today-tasks";

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
    ...overrides,
  };
}

describe("groupTodayTasks", () => {
  it("returns the input as one unlabeled group under 'none'", () => {
    const a = task({ id: "a" });
    const b = task({ id: "b" });

    expect(groupTodayTasks([a, b], "none")).toEqual([{ label: "", tasks: [a, b] }]);
  });

  it("returns no groups at all for an empty list", () => {
    expect(groupTodayTasks([], "none")).toEqual([]);
    expect(groupTodayTasks([], "priority")).toEqual([]);
  });

  it("groups by priority, P1 first through P4 last, omitting any empty bucket", () => {
    // stored 4 is UI P1, stored 2 is UI P3 (uiPriorityOf's own inversion).
    const p1 = task({ id: "p1", priority: 4 });
    const p3 = task({ id: "p3", priority: 2 });

    const groups = groupTodayTasks([p3, p1], "priority");

    expect(groups.map((g) => g.label)).toEqual(["Priority 1", "Priority 3"]);
    expect(groups[0]?.tasks).toEqual([p1]);
    expect(groups[1]?.tasks).toEqual([p3]);
  });

  // The regression this ticket's own brief names explicitly — a plausible-
  // sounding grouping implementation that "tidies" a bucket by re-sorting
  // it (by orderKey, by id, by anything) is describing the Todoist bug the
  // brief warns about, not a feature. Two Tasks sharing a priority, with
  // orderKeys that would swap their order if a bucket were re-sorted by
  // manual order, must come back in the order they were given — the order
  // task-views.ts's own compareForToday already decided.
  it("keeps a group's own Tasks in the order they arrived, even when their orderKeys disagree with that order", () => {
    const earlier = task({ id: "earlier", priority: 2, orderKey: "Z" });
    const later = task({ id: "later", priority: 2, orderKey: "A" });

    const groups = groupTodayTasks([earlier, later], "priority");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.tasks).toEqual([earlier, later]);
  });

  it("does not reorder across groups either — group order is fixed P1..P4, not derived from the input", () => {
    const p4 = task({ id: "p4", priority: 1 });
    const p1 = task({ id: "p1", priority: 4 });

    // p4 (UI) arrives first in the input; the grouped output still puts
    // its P1 group ahead of its P4 group.
    const groups = groupTodayTasks([p4, p1], "priority");

    expect(groups.map((g) => g.label)).toEqual(["Priority 1", "Priority 4"]);
  });
});
