import type { Task } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { todayTaskCount, upcomingTaskCount } from "./todo-view-task-count";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    deviceId: "device-a",
    content: "content",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    date: null,
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

const NOW = "2026-09-22";

describe("todayTaskCount — issue #437's 'N tasks' line under Today's title", () => {
  it("counts overdue plus due-today — exactly what today-view.tsx itself renders, nothing else", () => {
    const tasks = [
      task({ id: "overdue-1", date: "2026-09-20" }),
      task({ id: "overdue-2", date: "2026-09-21" }),
      task({ id: "today-1", date: "2026-09-22" }),
      // Future and undated Tasks are in neither of Today's own buckets.
      task({ id: "future", date: "2026-09-23" }),
      task({ id: "undated", date: null }),
    ];

    expect(todayTaskCount(tasks, NOW)).toBe(3);
  });

  it("is 0 for an empty Today, the same 'nothing here' state today-view.tsx's own empty state renders for", () => {
    const tasks = [task({ id: "future", date: "2026-09-23" })];

    expect(todayTaskCount(tasks, NOW)).toBe(0);
  });

  it("never counts a completed Task — TaskStore.list()'s own guarantee, relied on rather than re-checked here", () => {
    // today()'s own contract already excludes anything not in an active
    // `tasks` array; this only pins that this helper adds no filter of its
    // own that could silently diverge from it.
    const tasks = [task({ id: "a", date: "2026-09-22" })];

    expect(todayTaskCount(tasks, NOW)).toBe(1);
  });
});

describe("upcomingTaskCount — issue #437's 'N tasks' line under Upcoming's title", () => {
  // Todoist's own Upcoming has no "N tasks" line to measure against
  // (issue #437's own body). Chosen definition, stated here rather than
  // left implicit: every Task upcoming-view.tsx itself renders — its own
  // Overdue section (identical to Today's) PLUS every dated day section
  // `upcoming()` returns — the same "count what the view shows" rule
  // `todayTaskCount` above already follows, extended to Upcoming's wider
  // window rather than invented as a second rule.
  it("counts overdue plus every day section's own Tasks", () => {
    const tasks = [
      task({ id: "overdue-1", date: "2026-09-20" }),
      task({ id: "today-1", date: "2026-09-22" }),
      task({ id: "future-1", date: "2026-09-25" }),
      task({ id: "future-2", date: "2026-09-25" }),
      // Undated Tasks never enter Upcoming's own union.
      task({ id: "undated", date: null }),
    ];

    expect(upcomingTaskCount(tasks, NOW)).toBe(4);
  });

  it("is 0 when nothing is overdue and nothing has a Date today or later", () => {
    expect(upcomingTaskCount([], NOW)).toBe(0);
  });
});
