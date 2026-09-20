import type { Task } from "@meologue/core";
import { mustParseLocalDateTimeKey } from "@meologue/core";
import { describe, expect, it, vi } from "vitest";
import { commitTaskTitle, type TaskTitleCommitSetters } from "./task-title-commit";

const NOW = mustParseLocalDateTimeKey("2026-09-02T00:00"); // Wednesday, midnight.
// `setTaskDateString`'s own `today` parameter stays `LocalDayKey`
// (issue #383 doesn't touch `TaskStore` at all) — `commitTaskTitle`
// derives it from `options.now` via `localDayKeyOf`, so an assertion on
// what that setter was actually called with needs the day alone, not
// `NOW`'s own `LocalDateTimeKey` shape.
const NOW_DAY = "2026-09-02";

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
    setTaskPriority: vi.fn(),
    setTaskDateString: vi.fn(),
    setTaskLabels: vi.fn(),
    resolveLabelIds: vi.fn(async () => []),
    setTaskProject: vi.fn(),
    setTaskSection: vi.fn(),
    resolveProjectId: vi.fn(async () => "resolved-project"),
    resolveSectionId: vi.fn(async () => "resolved-section"),
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

  // Issue #376 removed `setTaskDeadline` (no surface can set one
  // anymore), so a restored `deadline` value on the existing Task is
  // included only to prove the rename path still tolerates it.
  it("skips every date-family setter when nothing resolved, leaving an existing Date/Priority/Labels untouched", async () => {
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

  // Issue #376: `{tomorrow}` still tokenises as "deadline" (issue #377
  // removes that rule; untouched here), but this module has no
  // `setTaskDeadline` left to call — the braces stay in the renamed
  // content instead of being silently consumed.
  it("keeps a typed {deadline} phrase as literal renamed content, calling no setter for it", async () => {
    const existing = task({ content: "buy milk", deadline: "2026-09-03" });
    const s = setters();
    await commitTaskTitle(existing, "buy milk {tomorrow}", { now: NOW }, s);

    expect(s.renameTask).toHaveBeenCalledWith("task-1", "buy milk {tomorrow}");
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

    expect(s.setTaskDateString).toHaveBeenCalledWith("task-1", "every month", NOW_DAY);
  });

  it("skips setTaskDateString when the resolved recurrence already equals the Task's own", async () => {
    const existing = task({ content: "pay rent", dateString: "every month", date: NOW });
    const s = setters();
    await commitTaskTitle(existing, "pay rent monthly", { now: NOW }, s);

    expect(s.setTaskDateString).not.toHaveBeenCalled();
  });

  // Issue #370: renaming a Task runs through this exact function
  // (taskFieldsForRename, the seam this module calls straight through
  // to), so a typed `#project` moves it — intended, matching how a typed
  // date or priority already overwrite an existing value on rename.
  describe("a typed #project/section on rename (issue #370)", () => {
    it("does not call resolveProjectId when no #project was typed", async () => {
      const s = setters();
      await commitTaskTitle(task({ content: "buy milk" }), "buy oat milk", { now: NOW }, s);

      expect(s.resolveProjectId).not.toHaveBeenCalled();
      expect(s.setTaskProject).not.toHaveBeenCalled();
    });

    it("moves the Task when a typed #project resolves to a different Project", async () => {
      const existing = task({ content: "buy milk", projectId: "old-project" });
      const s = setters({ resolveProjectId: vi.fn(async () => "new-project") });
      await commitTaskTitle(existing, "buy milk #Work", { now: NOW }, s);

      expect(s.resolveProjectId).toHaveBeenCalledWith("Work");
      expect(s.setTaskProject).toHaveBeenCalledWith("task-1", "new-project");
    });

    it("skips setTaskProject when the resolved Project already equals the Task's own", async () => {
      const existing = task({ content: "buy milk", projectId: "same-project" });
      const s = setters({ resolveProjectId: vi.fn(async () => "same-project") });
      await commitTaskTitle(existing, "buy milk #Work", { now: NOW }, s);

      expect(s.setTaskProject).not.toHaveBeenCalled();
    });

    it("strips the #project sigil from the renamed content", async () => {
      const existing = task({ content: "buy milk" });
      const s = setters();
      await commitTaskTitle(existing, "buy oat milk #Work", { now: NOW }, s);

      expect(s.renameTask).toHaveBeenCalledWith("task-1", "buy oat milk");
    });

    it("resolves a typed /section within the typed #project, not the Task's own existing Project", async () => {
      const existing = task({ content: "buy milk", projectId: "old-project", sectionId: null });
      const resolveProjectId = vi.fn(async () => "new-project");
      const resolveSectionId = vi.fn(async () => "new-section");
      const s = setters({ resolveProjectId, resolveSectionId });
      // A Section name is a single "word" run (letters/digits/`_`/`-`) —
      // ../../packages/core/src/quick-add/rules.ts's own `WORD_NAME_PATTERN`
      // doc comment, unchanged by this ticket ("packages/core needs zero
      // parsing changes").
      await commitTaskTitle(existing, "buy milk #Work /Cutover", { now: NOW }, s);

      expect(resolveSectionId).toHaveBeenCalledWith("new-project", "Cutover");
      expect(s.setTaskSection).toHaveBeenCalledWith("task-1", "new-section");
    });

    it("resolves a typed /section within the Task's own existing Project when no #project was typed", async () => {
      const existing = task({ content: "buy milk", projectId: "existing-project" });
      const resolveSectionId = vi.fn(async () => "new-section");
      const s = setters({ resolveSectionId });
      await commitTaskTitle(existing, "buy milk /Cutover", { now: NOW }, s);

      expect(resolveSectionId).toHaveBeenCalledWith("existing-project", "Cutover");
      expect(s.setTaskSection).toHaveBeenCalledWith("task-1", "new-section");
    });

    it("ignores a typed /section when the Task has no Project, typed or existing", async () => {
      const existing = task({ content: "buy milk", projectId: null });
      const s = setters();
      await commitTaskTitle(existing, "buy milk /Cutover", { now: NOW }, s);

      expect(s.resolveSectionId).not.toHaveBeenCalled();
      expect(s.setTaskSection).not.toHaveBeenCalled();
    });

    it("skips setTaskSection when the resolved Section already equals the Task's own", async () => {
      const existing = task({
        content: "buy milk",
        projectId: "existing-project",
        sectionId: "same-section",
      });
      const s = setters({ resolveSectionId: vi.fn(async () => "same-section") });
      await commitTaskTitle(existing, "buy milk /Cutover", { now: NOW }, s);

      expect(s.setTaskSection).not.toHaveBeenCalled();
    });
  });
});
