import { describe, expect, it } from "vitest";
import { project } from "../test-support/project-fixture";
import { task } from "../test-support/task-fixture";
import { renderTasksFile } from "./tasks-file";

const OFFSET_IST = 330; // +05:30

describe("renderTasksFile", () => {
  it("writes an explicit empty file for no Tasks, rather than omitting it", () => {
    expect(renderTasksFile([], [], 0)).toEqual({ path: "tasks.txt", contents: "No Tasks.\n" });
  });

  it("groups by Project, Inbox first, named Projects alphabetical thereafter", () => {
    const projects = [
      project({ id: "p-zebra", name: "Zebra Crossing" }),
      project({ id: "p-apple", name: "Apple Orchard" }),
    ];
    const tasks = [
      task({ id: "t-zebra", content: "zebra task", projectId: "p-zebra" }),
      task({ id: "t-inbox", content: "inbox task", projectId: null }),
      task({ id: "t-apple", content: "apple task", projectId: "p-apple" }),
    ];

    const file = renderTasksFile(tasks, projects, OFFSET_IST);

    expect(file.path).toBe("tasks.txt");
    const headings = file.contents.split("\n").filter((line) => line.startsWith("# "));
    expect(headings).toEqual(["# Inbox", "# Apple Orchard", "# Zebra Crossing"]);
  });

  it("names a Task whose Project this export can't resolve, rather than folding it into Inbox", () => {
    const tasks = [task({ id: "t1", content: "orphaned", projectId: "missing-project" })];

    const file = renderTasksFile(tasks, [], OFFSET_IST);

    expect(file.contents).toContain("# Unresolved Project (missing-project)");
    expect(file.contents).not.toContain("# Inbox");
  });

  it("renders an active Task as an unchecked line with no metadata when it has none", () => {
    const tasks = [task({ id: "t1", content: "buy milk", projectId: null })];

    const file = renderTasksFile(tasks, [], OFFSET_IST);

    expect(file.contents).toBe(["# Inbox", "", "- [ ] buy milk", ""].join("\n"));
  });

  it("renders priority, date, deadline and recurrence as a parenthetical, in that order", () => {
    const tasks = [
      task({
        id: "t1",
        content: "renew passport",
        projectId: null,
        priority: 4, // stored 4 == UI p1, the most urgent
        date: "2026-09-05",
        deadline: "2026-09-10",
        dateString: "every year",
      }),
    ];

    const file = renderTasksFile(tasks, [], OFFSET_IST);

    expect(file.contents).toContain(
      "- [ ] renew passport (p1, due 2026-09-05, deadline 2026-09-10, every year)",
    );
  });

  it("never adjusts a floating date/deadline by the exporting Device's offset", () => {
    // date/deadline are floating (task-types.ts) — a plan for "2026-09-05"
    // stays "2026-09-05" regardless of what offset the export was taken
    // under, unlike completedAt below, which is a real UTC instant.
    const tasks = [task({ id: "t1", content: "x", projectId: null, date: "2026-09-05" })];

    const file = renderTasksFile(tasks, [], -480); // UTC-8

    expect(file.contents).toContain("due 2026-09-05");
  });

  it("marks a completed Task with [x] and its local completion date", () => {
    const tasks = [
      task({
        id: "t1",
        content: "call plumber",
        projectId: null,
        completedAt: "2026-08-30T20:00:00.000Z", // 2026-08-31 01:30 local at +05:30
      }),
    ];

    const file = renderTasksFile(tasks, [], OFFSET_IST);

    expect(file.contents).toContain("- [x] call plumber (completed 2026-08-31)");
  });

  it("lists a Project's active Tasks before its completed ones", () => {
    const tasks = [
      task({
        id: "done",
        content: "already done",
        projectId: null,
        completedAt: "2026-08-01T00:00:00.000Z",
      }),
      task({ id: "active", content: "still open", projectId: null, orderKey: "V" }),
    ];

    const file = renderTasksFile(tasks, [], OFFSET_IST);

    const lines = file.contents.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual(["- [ ] still open", "- [x] already done (completed 2026-08-01)"]);
  });

  it("orders completed Tasks newest-completion-first", () => {
    const tasks = [
      task({
        id: "older",
        content: "older",
        projectId: null,
        completedAt: "2026-08-01T00:00:00.000Z",
      }),
      task({
        id: "newer",
        content: "newer",
        projectId: null,
        completedAt: "2026-08-15T00:00:00.000Z",
      }),
    ];

    const file = renderTasksFile(tasks, [], OFFSET_IST);

    const lines = file.contents.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
      "- [x] newer (completed 2026-08-15)",
      "- [x] older (completed 2026-08-01)",
    ]);
  });

  it("orders active Tasks by (orderKey, id), the same order Todo's own TaskStore.list() uses", () => {
    const tasks = [
      task({ id: "second", content: "second", projectId: null, orderKey: "b" }),
      task({ id: "first", content: "first", projectId: null, orderKey: "a" }),
    ];

    const file = renderTasksFile(tasks, [], OFFSET_IST);

    const lines = file.contents.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual(["- [ ] first", "- [ ] second"]);
  });
});
