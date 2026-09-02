import type { Task } from "@meologue/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "./today-view";

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

function renderTodayView(overrides: Partial<Parameters<typeof TodayView>[0]> = {}) {
  const props = {
    tasks: [] as Task[],
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
    onSetDate: vi.fn(),
    onPostpone: vi.fn(),
    ...overrides,
  };
  render(<TodayView {...props} />);
  return props;
}

describe("TodayView", () => {
  // "Now" is pinned so overdue/due-today classification (task-views.ts's
  // own today()) doesn't depend on whatever day this suite happens to run
  // on — the same reasoning date-picker-sheet.tsx's own localDayKey exists
  // to make deterministic from a Date this test controls.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026, local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // This ticket's own acceptance criterion, worded with care rather than a
  // bare icon — see today-view.tsx's own comment on why.
  it("reads a fully clear Today as an achievement, not a blank panel", () => {
    renderTodayView({ tasks: [] });

    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is due today, and nothing is overdue/)).toBeInTheDocument();
  });

  it("does not show the achievement state while anything is overdue or due today", () => {
    renderTodayView({ tasks: [task({ id: "a", content: "call mum", date: "2026-09-02" })] });

    expect(screen.queryByText("All caught up")).not.toBeInTheDocument();
  });

  it("places an overdue Task in its own section, separate from due-today", () => {
    renderTodayView({
      tasks: [
        task({ id: "late", content: "late task", date: "2026-08-30" }),
        task({ id: "today", content: "today task", date: "2026-09-02" }),
      ],
    });

    expect(screen.getByText("Overdue (1)")).toBeInTheDocument();
    expect(screen.getByText("late task")).toBeInTheDocument();
    expect(screen.getByText("Due today (1)")).toBeInTheDocument();
    expect(screen.getByText("today task")).toBeInTheDocument();
  });

  // The union rule task-views.ts's own today() implements: an undated Task
  // whose deadline has already passed still surfaces, in Overdue.
  it("surfaces an undated Task once its deadline has arrived, in Overdue", () => {
    renderTodayView({
      tasks: [task({ id: "no-date", content: "no date task", deadline: "2026-09-01" })],
    });

    expect(screen.getByText("Overdue (1)")).toBeInTheDocument();
    expect(screen.getByText("no date task")).toBeInTheDocument();
  });

  // This ticket's own headline sort case: a p4 due earlier outranks a p1
  // due later, and Due today must render them in that order.
  it("orders due-today Tasks by time first, priority only as a tie-break", () => {
    const early = task({ id: "early", content: "early", date: "2026-09-02T09:00", priority: 1 });
    const late = task({ id: "late", content: "late", date: "2026-09-02T15:00", priority: 4 });
    renderTodayView({ tasks: [late, early] });

    const rows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
    const earlyIndex = rows.findIndex((text) => text.includes("early"));
    const lateIndex = rows.findIndex((text) => text.includes("late"));
    expect(earlyIndex).toBeGreaterThanOrEqual(0);
    expect(earlyIndex).toBeLessThan(lateIndex);
  });

  it("completing a row calls onComplete with the Task's id, content and dateString", () => {
    const onComplete = vi.fn();
    renderTodayView({
      tasks: [task({ id: "a", content: "call mum", date: "2026-09-02" })],
      onComplete,
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "call mum" }));

    expect(onComplete).toHaveBeenCalledWith("a", "call mum", null);
  });

  it("Shift+Click on a recurring row calls onCompleteForever with its id and content", () => {
    const onComplete = vi.fn();
    const onCompleteForever = vi.fn();
    renderTodayView({
      tasks: [
        task({ id: "a", content: "pay rent", date: "2026-09-02", dateString: "every month" }),
      ],
      onComplete,
      onCompleteForever,
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "pay rent" }), { shiftKey: true });

    expect(onCompleteForever).toHaveBeenCalledWith("a", "pay rent");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("renders no drag handle anywhere — Today's order is computed, not dragged", () => {
    renderTodayView({
      tasks: [
        task({ id: "a", content: "a", date: "2026-08-30" }),
        task({ id: "b", content: "b", date: "2026-09-02" }),
      ],
    });

    expect(screen.queryByTestId("task-drag-handle")).not.toBeInTheDocument();
  });

  describe("Reschedule", () => {
    it("offers a Reschedule action only when something is overdue", () => {
      renderTodayView({ tasks: [task({ id: "a", content: "a", date: "2026-09-02" })] });

      expect(screen.queryByRole("button", { name: "Reschedule" })).not.toBeInTheDocument();
    });

    it("rescheduling sets the date of every overdue Task to the chosen day, and touches nothing else", () => {
      const onSetDate = vi.fn();
      renderTodayView({
        tasks: [
          task({ id: "a", content: "a", date: "2026-08-30" }),
          task({ id: "b", content: "b", deadline: "2026-08-31" }),
        ],
        onSetDate,
      });

      fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
      // The nested DatePickerSheet's own tap-then-confirm: pick a day, then
      // confirm — Confirm stays disabled until a day is tapped.
      fireEvent.click(screen.getByRole("button", { name: /September 20th, 2026/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));

      expect(onSetDate).toHaveBeenCalledTimes(2);
      expect(onSetDate).toHaveBeenCalledWith("a", expect.any(String));
      expect(onSetDate).toHaveBeenCalledWith("b", expect.any(String));
    });
  });

  describe("Postpone to tomorrow", () => {
    it("offers the action only when something is overdue", () => {
      renderTodayView({ tasks: [task({ id: "a", content: "a", date: "2026-09-02" })] });

      expect(
        screen.queryByRole("button", { name: "Postpone to tomorrow" }),
      ).not.toBeInTheDocument();
    });

    // Issue #170's own case: "postponing an overdue recurring task moves it
    // to tomorrow" — but postpone's own mechanics have nothing recurrence-
    // specific about them, so a non-recurring overdue Task is postponed
    // exactly the same way, in the same one-tap action.
    it("postpones every overdue Task, recurring or not, with one tap and no picker", () => {
      const onPostpone = vi.fn();
      renderTodayView({
        tasks: [
          task({ id: "a", content: "a", date: "2026-08-30", dateString: "every month" }),
          task({ id: "b", content: "b", deadline: "2026-08-31" }),
        ],
        onPostpone,
      });

      fireEvent.click(screen.getByRole("button", { name: "Postpone to tomorrow" }));

      expect(onPostpone).toHaveBeenCalledTimes(2);
      expect(onPostpone).toHaveBeenCalledWith("a");
      expect(onPostpone).toHaveBeenCalledWith("b");
    });
  });

  describe("grouping", () => {
    it("defaults to no grouping — a single flat list in chain order", () => {
      renderTodayView({
        tasks: [
          task({ id: "a", content: "a", date: "2026-09-02T09:00", priority: 4 }),
          task({ id: "b", content: "b", date: "2026-09-02T15:00", priority: 1 }),
        ],
      });

      expect(screen.queryByText(/^Priority \d$/)).not.toBeInTheDocument();
    });

    it("groups due-today Tasks by priority, with a heading per non-empty group", () => {
      renderTodayView({
        tasks: [
          task({ id: "a", content: "a", date: "2026-09-02T09:00", priority: 4 }), // UI P1
          task({ id: "b", content: "b", date: "2026-09-02T15:00", priority: 1 }), // UI P4
        ],
      });

      fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "priority" } });

      expect(screen.getByText("Priority 1")).toBeInTheDocument();
      expect(screen.getByText("Priority 4")).toBeInTheDocument();
    });

    // The regression this ticket's own brief names explicitly: grouping
    // must never collapse the within-group order to something other than
    // the chain — two same-priority Tasks at different times must stay
    // time-ordered inside their shared group.
    it("keeps same-priority Tasks time-ordered within their group, not collapsed to priority", () => {
      const early = task({ id: "early", content: "early", date: "2026-09-02T09:00", priority: 2 });
      const late = task({ id: "late", content: "late", date: "2026-09-02T15:00", priority: 2 });
      renderTodayView({ tasks: [late, early] });

      fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "priority" } });

      const group = screen.getByText("Priority 3").closest("div");
      if (group === null) throw new Error("expected a Priority 3 group");
      const rows = within(group)
        .getAllByRole("listitem")
        .map((row) => row.textContent ?? "");
      const earlyIndex = rows.findIndex((text) => text.includes("early"));
      const lateIndex = rows.findIndex((text) => text.includes("late"));
      expect(earlyIndex).toBeGreaterThanOrEqual(0);
      expect(earlyIndex).toBeLessThan(lateIndex);
    });
  });
});
