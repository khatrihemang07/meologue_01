import type { Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskScheduleSheet } from "./task-schedule-sheet";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
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
  const onSetDate = vi.fn();
  const onSetDeadline = vi.fn();
  const onSetPriority = vi.fn();
  render(
    <TaskScheduleSheet
      task={task(overrides)}
      open={true}
      onOpenChange={vi.fn()}
      onSetDate={onSetDate}
      onSetDeadline={onSetDeadline}
      onSetPriority={onSetPriority}
    />,
  );
  return { onSetDate, onSetDeadline, onSetPriority };
}

describe("TaskScheduleSheet", () => {
  // Today/Tomorrow are pinned to a known "now" the same way
  // today-view.test.tsx pins it, so their emitted day keys are asserted
  // exactly rather than "some string".
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026, local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the Task being scheduled", () => {
    renderSheet({ content: "call mum" });

    expect(screen.getByText('Schedule "call mum"')).toBeInTheDocument();
  });

  it("shows a recurring Task's dateString exactly as typed", () => {
    renderSheet({ dateString: "every other monday" });

    expect(screen.getByText("Repeats: every other monday")).toBeInTheDocument();
  });

  it("shows nothing for a non-recurring Task", () => {
    renderSheet({ dateString: null });

    expect(screen.queryByText(/Repeats:/)).not.toBeInTheDocument();
  });

  describe("Date", () => {
    it("'Today' sets the date to today's local day key", () => {
      const { onSetDate } = renderSheet();

      fireEvent.click(screen.getByRole("button", { name: "Today" }));

      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-02");
    });

    it("'Tomorrow' sets the date to the next local day key", () => {
      const { onSetDate } = renderSheet();

      fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));

      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-03");
    });

    it("'Pick a date' opens the nested DatePickerSheet, and confirming sets the date", () => {
      const { onSetDate } = renderSheet();

      fireEvent.click(screen.getByRole("button", { name: "Pick a date" }));
      fireEvent.click(screen.getByRole("button", { name: /September 20th, 2026/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));

      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-20");
    });

    it("offers no Clear button until a date is set, and Clear sets it to null once one is", () => {
      const { onSetDate } = renderSheet({ date: "2026-09-05" });

      expect(screen.getByRole("button", { name: "Clear date" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Clear date" }));

      expect(onSetDate).toHaveBeenCalledWith("1", null);
    });

    it("offers no 'Add a time' toggle until a date is set", () => {
      renderSheet({ date: null });

      expect(screen.queryByText("Add a time")).not.toBeInTheDocument();
    });

    it("checking 'Add a time' sets a default time on the existing date", () => {
      const { onSetDate } = renderSheet({ date: "2026-09-05" });

      fireEvent.click(screen.getByLabelText("Add a time"));

      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-05T09:00");
    });

    it("changing the time input keeps the same day", () => {
      const { onSetDate } = renderSheet({ date: "2026-09-05T09:00" });

      fireEvent.change(screen.getByLabelText("Time"), { target: { value: "14:30" } });

      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-05T14:30");
    });

    it("unchecking 'Add a time' drops back to an all-day date", () => {
      const { onSetDate } = renderSheet({ date: "2026-09-05T09:00" });

      fireEvent.click(screen.getByLabelText("Add a time"));

      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-05");
    });

    it("picking a new day through 'Pick a date' preserves an existing time of day", () => {
      const { onSetDate } = renderSheet({ date: "2026-09-05T09:00" });

      fireEvent.click(screen.getByRole("button", { name: "Sep 5" }));
      fireEvent.click(screen.getByRole("button", { name: /September 20th, 2026/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));

      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-20T09:00");
    });
  });

  describe("Deadline", () => {
    it("'Pick a deadline' opens the nested DatePickerSheet, and confirming sets the deadline", () => {
      const { onSetDeadline } = renderSheet();

      fireEvent.click(screen.getByRole("button", { name: "Pick a deadline" }));
      fireEvent.click(screen.getByRole("button", { name: /September 20th, 2026/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));

      expect(onSetDeadline).toHaveBeenCalledWith("1", "2026-09-20");
    });

    it("offers Clear only once a deadline is set", () => {
      const { onSetDeadline } = renderSheet({ deadline: "2026-09-10" });

      fireEvent.click(screen.getByRole("button", { name: "Clear deadline" }));

      expect(onSetDeadline).toHaveBeenCalledWith("1", null);
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
});
