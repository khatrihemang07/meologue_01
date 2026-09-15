import type { Task } from "@meologue/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swipeDown, swipeLeft } from "@/test/swipe";
import { TodayView } from "./today-view";

/** The `[data-task-row-box]` `<div>` inside the row that renders `label` — the element `use-swipe-actions.ts` picks up (`SWIPE_TARGET_ATTRIBUTE`'s own doc comment), same as task-tree.test.tsx's identical helper. */
function rowBox(label: string): HTMLElement {
  const row = screen.getByText(label).closest("li");
  if (!row) throw new Error(`expected a row for "${label}"`);
  const box = row.querySelector<HTMLElement>(":scope > [data-task-row-box]");
  if (!box) throw new Error(`expected a row box on "${label}"'s row`);
  return box;
}

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

function renderTodayView(overrides: Partial<Parameters<typeof TodayView>[0]> = {}) {
  const props = {
    tasks: [] as Task[],
    detailActions: {
      projects: [],
      labels: [],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetDate: vi.fn(),
      onSetDateString: vi.fn(),
      datesWithTasks: new Map(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      onRename: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
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
  // on — the same reasoning lib/local-day-key.ts's own localDayKey exists
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

  // ROW-13 (parity-ledger.md), issue #250: every row in Due today is due
  // today by construction, so its own date badge says nothing a reader
  // doesn't already know from the section heading — Todoist omits the
  // control from the DOM there entirely (pass2-2026-09-11.md §3). Overdue
  // keeps its own badge: an overdue row's date is never redundant.
  it("renders no date badge on a due-today row, but keeps one on an overdue row", () => {
    renderTodayView({
      tasks: [
        task({ id: "late", content: "late task", date: "2026-09-01" }),
        task({ id: "today", content: "today task", date: "2026-09-02" }),
      ],
    });

    const overdueRow = screen.getByText("late task").closest("li");
    const dueTodayRow = screen.getByText("today task").closest("li");
    expect(overdueRow).not.toBeNull();
    expect(dueTodayRow).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    expect(within(overdueRow!).getByText("Yesterday")).toBeInTheDocument();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    expect(within(dueTodayRow!).queryByText("Today")).not.toBeInTheDocument();
  });

  // DATE-04 (parity-ledger.md): driven live on Today (flow 2) — a
  // recurring Task due today is not fully suppressed the way a plain
  // due-today row is. Todoist keeps the `due-date-control` button but
  // empties its text, leaving an icon-only badge tinted the Today green
  // (`live-audit-dom/flow2-ROW-13-todoist.json`'s own
  // `recurringDueTodayRow`). meologue used to suppress the resolved date
  // entirely here, same as a non-recurring row, and rely solely on the
  // separate `task.dateString` text badge — this pins the icon-only badge
  // instead.
  it("shows an icon-only recurrence badge, not the full suppression, on a recurring due-today row", () => {
    renderTodayView({
      tasks: [
        task({
          id: "recurring-today",
          content: "water plants",
          date: "2026-09-02",
          dateString: "every day",
        }),
      ],
    });

    const dueTodayRow = screen.getByText("water plants").closest("li");
    expect(dueTodayRow).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    const row = dueTodayRow!;
    // Neither the resolved "Today" word nor the "↻" it would otherwise
    // carry shows up — the badge is icon-only, not text-plus-icon.
    expect(within(row).queryByText("Today")).not.toBeInTheDocument();
    expect(within(row).queryByText(/↻/)).not.toBeInTheDocument();
    expect(row.querySelector("svg.lucide-repeat")).not.toBeNull();
    // The separate literal `task.dateString` badge is untouched — only
    // ROW-13's Today view was re-driven, not this app's own additive badge.
    expect(within(row).getByText("every day")).toBeInTheDocument();
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

    // ROW-03 (parity-ledger.md): the checkbox's accessible name is now
    // Todoist's own fixed wording, not the Task's content — see
    // task-row.test.tsx's own header comment on the same change.
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as complete" }));

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

    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as complete" }), {
      shiftKey: true,
    });

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

  // Issue #303: reuses `use-swipe-actions.ts`'s shared recogniser (the
  // identical one `history.tsx`'s own bubbles use), attached once to this
  // view's own outer wrapper so both the Overdue and Due-today sections'
  // own `<ul>`s — separate DOM subtrees, unlike TaskTree's own nested
  // levels — are covered by a single instance. The recogniser's own
  // arithmetic is mutation-tested in `swipe-recognizer.test.ts` and
  // `use-swipe-actions.test.tsx`; this only proves the wiring reaches
  // Today's own rows at all.
  describe("swipe-to-schedule (issue #303)", () => {
    it("opens the swiped row's own schedule popover, in either section", () => {
      renderTodayView({
        tasks: [
          task({ id: "late", content: "late task", date: "2026-08-30" }),
          task({ id: "today", content: "today task", date: "2026-09-02" }),
        ],
      });

      swipeLeft(rowBox("late task"));
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    it("does not open anything for a vertical drag", () => {
      renderTodayView({
        tasks: [task({ id: "today", content: "today task", date: "2026-09-02" })],
      });

      swipeDown(rowBox("today task"));

      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });
  });
});
