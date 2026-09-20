import type { Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskScheduleSheet } from "./task-schedule-sheet";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
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
    description: null,
    ...overrides,
  };
}

function renderSheet(overrides: Partial<Task> = {}) {
  const onSetPriority = vi.fn();
  render(
    <TaskScheduleSheet
      task={task(overrides)}
      open={true}
      onOpenChange={vi.fn()}
      onSetPriority={onSetPriority}
    />,
  );
  return { onSetPriority };
}

describe("TaskScheduleSheet", () => {
  it("names the Task being scheduled", () => {
    renderSheet({ content: "call mum" });

    expect(screen.getByText('Schedule "call mum"')).toBeInTheDocument();
  });

  // Issue #253: Date — and with it, the "Repeats: …"/"Clear repeat"
  // read-out — left this sheet entirely for its own anchored
  // `TaskSchedulePopover` instance (task-schedule-sheet.tsx's own header
  // comment). This sheet no longer renders a Recurrence at all, on a
  // recurring Task or otherwise; `task-row.test.tsx`/`task-detail-view.test.tsx`
  // cover the popover's own wiring now.
  it("renders no Date section, and nothing naming a Recurrence, even on a recurring Task", () => {
    renderSheet({ dateString: "every other monday" });

    expect(screen.queryByText("Date")).not.toBeInTheDocument();
    expect(screen.queryByText(/Repeats:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick a date" })).not.toBeInTheDocument();
  });

  // Issue #376: no surface offers to set, edit, clear or display a
  // deadline — this sheet used to hold Deadline alongside Priority
  // (task-schedule-sheet.tsx's own former header comment); that half is
  // gone, and a restored `deadline` value renders nothing.
  describe("Deadline", () => {
    it("renders no Deadline section, on a Task with or without a deadline value", () => {
      renderSheet({ deadline: "2026-09-10" });

      expect(screen.queryByText("Deadline")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pick a deadline" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Clear deadline" })).not.toBeInTheDocument();
    });
  });

  describe("Priority", () => {
    it("marks the Task's current UI priority as pressed", () => {
      // stored 4 is UI P1 (uiPriorityOf's own inversion).
      renderSheet({ priority: 4 });

      expect(screen.getByRole("button", { name: "P1" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "P4" })).toHaveAttribute("aria-pressed", "false");
    });

    it("picking P2 stores it inverted, through storedPriorityOf — never open-coded", () => {
      const { onSetPriority } = renderSheet({ priority: 1 });

      fireEvent.click(screen.getByRole("button", { name: "P2" }));

      // storedPriorityOf(2) === 3.
      expect(onSetPriority).toHaveBeenCalledWith("1", 3);
    });
  });

  it("colours each priority option, as the row menu's picker already does", () => {
    // Todoist colours its priority options wherever it offers them — red,
    // orange, blue, and an unfilled P4. This sheet was the one picker in
    // meologue rendering four identical text buttons, even though
    // `--td-priority-picker-1..4` already existed (ADR 0069) and
    // `task-command-menu.tsx` already read them.
    renderSheet();

    const swatches = screen
      .getAllByRole("button")
      .filter((b) => /^P[1-4]$/.test(b.textContent ?? ""))
      .map((b) => b.querySelector("span")?.getAttribute("style") ?? "");

    expect(swatches).toHaveLength(4);
    for (const style of swatches) {
      expect(style).toContain("background-color");
    }
    // Four distinct colours, not one repeated — the assertion that would
    // survive someone wiring every option to the same token.
    expect(new Set(swatches).size).toBe(4);
  });
});
