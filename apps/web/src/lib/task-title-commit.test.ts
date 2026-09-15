import type { Task } from "@meologue/core";
import { mustParseLocalDayKey } from "@meologue/core";
import { describe, expect, it, vi } from "vitest";
import { commitTaskTitle, type TaskTitleCommitSetters } from "./task-title-commit";

const NOW = mustParseLocalDayKey("2026-09-02"); // Wednesday.

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    deviceId: "device-1",
    content: "buy milk",
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

function setters(overrides: Partial<TaskTitleCommitSetters> = {}): TaskTitleCommitSetters {
  return {
    renameTask: vi.fn(),
    setTaskDate: vi.fn(),
    setTaskDeadline: vi.fn(),
    setTaskPriority: vi.fn(),
    setTaskDateString: vi.fn(),
    setTaskLabels: vi.fn(),
    resolveLabelIds: vi.fn(async () => []),
    ...overrides,
  };
}

describe("commitTaskTitle", () => {
  it("touches only the setters a recognised token actually resolved", async () => {
    const s = setters();
    await commitTaskTitle(task({ content: "buy milk" }), "buy milk tomorrow p1", { now: NOW }, s);

    expect(s.renameTask).not.toHaveBeenCalled();
    expect(s.setTaskDate).toHaveBeenCalledWith("task-1", "2026-09-03");
    expect(s.setTaskPriority).toHaveBeenCalledWith("task-1", 4);
    expect(s.setTaskDeadline).not.toHaveBeenCalled();
    expect(s.setTaskDateString).not.toHaveBeenCalled();
    expect(s.setTaskLabels).not.toHaveBeenCalled();
  });

  it("renames when the resolved content actually changed", async () => {
    const s = setters();
    await commitTaskTitle(task({ content: "buy milk" }), "buy oat milk", { now: NOW }, s);

    expect(s.renameTask).toHaveBeenCalledWith("task-1", "buy oat milk");
  });

  // The correctness guard the design calls out by name: the raw typed text
  // ("buy milk tomorrow") differs from task.content, but once "tomorrow" is
  // recognised and stripped, the resolved content ("buy milk") is identical
  // to what the Task already holds — renameTask must not fire, or a
  // spurious "you changed the name" Activity line buries the real story
  // ("you set the date").
  it("skips renameTask when the resolved content equals the Task's current content", async () => {
    const s = setters();
    await commitTaskTitle(task({ content: "buy milk" }), "buy milk tomorrow", { now: NOW }, s);

    expect(s.renameTask).not.toHaveBeenCalled();
    expect(s.setTaskDate).toHaveBeenCalledWith("task-1", "2026-09-03");
  });

  it("skips every date-family setter when nothing resolved, leaving an existing Date/Deadline/Priority/Labels untouched", async () => {
    const existing = task({
      content: "buy milk",
      date: "2026-09-10",
      deadline: "2026-09-15",
      priority: 3,
      labelIds: ["label-a"],
    });
    const s = setters();
    await commitTaskTitle(existing, "buy oat milk", { now: NOW }, s);

    expect(s.renameTask).toHaveBeenCalledWith("task-1", "buy oat milk");
    expect(s.setTaskDate).not.toHaveBeenCalled();
    expect(s.setTaskDeadline).not.toHaveBeenCalled();
    expect(s.setTaskPriority).not.toHaveBeenCalled();
    expect(s.setTaskDateString).not.toHaveBeenCalled();
    expect(s.setTaskLabels).not.toHaveBeenCalled();
    expect(s.resolveLabelIds).not.toHaveBeenCalled();
  });

  it("skips setTaskDate when the resolved date already equals the Task's own", async () => {
    const existing = task({ content: "buy milk", date: "2026-09-03" });
    const s = setters();
    await commitTaskTitle(existing, "buy milk tomorrow", { now: NOW }, s);

    expect(s.setTaskDate).not.toHaveBeenCalled();
  });

  it("skips setTaskDeadline when the resolved deadline already equals the Task's own", async () => {
    const existing = task({ content: "buy milk", deadline: "2026-09-03" });
    const s = setters();
    await commitTaskTitle(existing, "buy milk {tomorrow}", { now: NOW }, s);

    expect(s.setTaskDeadline).not.toHaveBeenCalled();
  });

  // The sharpest priority case: typing "p4" resolves to the stored value
  // `1`, identical to a Task's own untouched default — but a real
  // "priority" token was typed, so `taskFieldsForRename` resolves `1`, not
  // `null`, and this must still overwrite an existing, higher priority.
  it("overwrites an existing priority with the degenerate p4 -> stored 1", async () => {
    const existing = task({ content: "buy milk", priority: 4 });
    const s = setters();
    await commitTaskTitle(existing, "buy milk p4", { now: NOW }, s);

    expect(s.setTaskPriority).toHaveBeenCalledWith("task-1", 1);
  });

  it("skips setTaskPriority when nothing resolved", async () => {
    const existing = task({ content: "buy milk", priority: 3 });
    const s = setters();
    await commitTaskTitle(existing, "buy oat milk", { now: NOW }, s);

    expect(s.setTaskPriority).not.toHaveBeenCalled();
  });

  it("does not call resolveLabelIds when no @label was typed", async () => {
    const s = setters();
    await commitTaskTitle(task({ content: "buy milk" }), "buy oat milk", { now: NOW }, s);

    expect(s.resolveLabelIds).not.toHaveBeenCalled();
  });

  it("merges resolved Labels into the Task's existing ones rather than replacing them", async () => {
    const existing = task({ content: "buy milk", labelIds: ["label-existing"] });
    const s = setters({ resolveLabelIds: vi.fn(async () => ["label-urgent"]) });
    await commitTaskTitle(existing, "buy milk @urgent", { now: NOW }, s);

    expect(s.resolveLabelIds).toHaveBeenCalledWith(["urgent"]);
    expect(s.setTaskLabels).toHaveBeenCalledWith("task-1", ["label-existing", "label-urgent"]);
  });

  it("skips setTaskLabels when the merge is a no-op — every resolved Label is already on the Task", async () => {
    const existing = task({ content: "buy milk", labelIds: ["label-urgent"] });
    const s = setters({ resolveLabelIds: vi.fn(async () => ["label-urgent"]) });
    await commitTaskTitle(existing, "buy milk @urgent", { now: NOW }, s);

    expect(s.resolveLabelIds).toHaveBeenCalledWith(["urgent"]);
    expect(s.setTaskLabels).not.toHaveBeenCalled();
  });

  it("resolves recurrence into setTaskDateString, passing options.now through", async () => {
    const s = setters();
    await commitTaskTitle(task({ content: "pay rent" }), "pay rent monthly", { now: NOW }, s);

    expect(s.setTaskDateString).toHaveBeenCalledWith("task-1", "every month", NOW);
  });

  it("skips setTaskDateString when the resolved recurrence already equals the Task's own", async () => {
    const existing = task({ content: "pay rent", dateString: "every month", date: NOW });
    const s = setters();
    await commitTaskTitle(existing, "pay rent monthly", { now: NOW }, s);

    expect(s.setTaskDateString).not.toHaveBeenCalled();
  });
});
