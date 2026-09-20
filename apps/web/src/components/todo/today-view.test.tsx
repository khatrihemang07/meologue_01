import type { Task } from "@meologue/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    ...overrides,
  };
  render(<TodayView {...props} />);
  return props;
}

// Issue #416: `TaskSchedulePopover` sits behind `LazyTaskSchedulePopover`
// now (a `React.lazy()` singleton, one module-level promise shared by every
// render in this file). Its first-ever resolution needs a real Promise
// microtask *and* a React scheduler callback to re-render the Suspense
// boundary — and once this suite's own `beforeEach` below swaps in
// `vi.useFakeTimers()`, that scheduler callback is captured against the
// faked timer APIs and never fires again, even from a test that later
// calls `vi.useRealTimers()` mid-test (confirmed empirically:
// `upcoming-view.test.tsx`'s identical wiring hit the same failure —
// switching back after the fact does not unstick an already-broken retry,
// only resolving it beforehand does). This primes that first resolution
// here, under real timers, before any test's `beforeEach` ever runs —
// every fake-timer test after this one renders the already-resolved
// component synchronously, with no Suspense retry needed at all.
beforeAll(async () => {
  renderTodayView({
    tasks: [task({ id: "warm-lazy-schedule-popover", content: "warm task", date: "2026-09-02" })],
  });
  swipeLeft(rowBox("warm task"));
  await waitFor(() => expect(screen.getByTestId("scheduler-view")).toBeInTheDocument(), {
    timeout: 5000,
  });
  cleanup();
});

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

    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("late task")).toBeInTheDocument();
    expect(screen.getByText("Due today (1)")).toBeInTheDocument();
    expect(screen.getByText("today task")).toBeInTheDocument();
  });

  // Issue #299/#337, the owner's own read of Todoist's reference
  // screenshots and DOM capture (overdue-section-summary.tsx's own header
  // comment has the citations): the Overdue heading is bare "Overdue," no
  // count, unlike this file's own "Due today (N)" a few lines above,
  // which keeps its count — Todoist doesn't extend the "no count"
  // treatment to every heading, only this one. A first cut of this
  // section read "Overdue (N)"; pinned here so a count can't creep back.
  it("pins the bare 'Overdue' header text — no digits, unlike this file's own 'Due today (N)'", () => {
    renderTodayView({
      tasks: [
        task({ id: "late-1", content: "late task one", date: "2026-08-30" }),
        task({ id: "late-2", content: "late task two", date: "2026-08-20" }),
      ],
    });

    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByText(/Overdue\s*\(\d+\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Overdue\s*\d/)).not.toBeInTheDocument();
  });

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
    expect(within(row).getByText("every day")).toBeInTheDocument();
  });

  // Before #375, today()'s union rule surfaced an undated Task here once
  // its deadline passed (task-views.ts's own former union arm). Deadline
  // is never read now (D12: Pro-gated in Todoist, 0 Tasks carry one in
  // either live database) — an undated Task stays invisible regardless of
  // what its deadline says, so there is nothing here for Overdue to show.
  it("does not surface an undated Task on its deadline alone, even once the deadline has passed (#375)", () => {
    renderTodayView({
      tasks: [task({ id: "no-date", content: "no date task", deadline: "2026-09-01" })],
    });

    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
    expect(screen.queryByText("no date task")).not.toBeInTheDocument();
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

    // Issue #337, measured off Todoist web's own computed styles: pins the
    // TOKEN (`--td-overdue-reschedule`, index.css's own comment has the
    // measurement and why it isn't `--td-date-overdue` or
    // `--td-calendar-today` despite one of those matching by coincidence),
    // not the literal `rgb(226, 106, 96)` — a later re-measure that moves
    // the token's own value should NOT fail this test; only a component
    // that stops reading the token should.
    it("reads its text colour from the --td-overdue-reschedule token, not a literal colour", () => {
      renderTodayView({ tasks: [task({ id: "a", content: "a", date: "2026-08-30" })] });

      const button = screen.getByRole("button", { name: "Reschedule" });
      expect(button.style.color).toBe("var(--td-overdue-reschedule)");
    });

    it("rescheduling sets the date of every overdue Task to the chosen day, and touches nothing else", () => {
      const onSetDate = vi.fn();
      renderTodayView({
        tasks: [
          task({ id: "a", content: "a", date: "2026-08-30" }),
          // Before #375 an undated Task with a passed deadline also counted
          // as overdue (task-views.ts's own former union arm) — deadline is
          // never read now, so this second overdue Task needs its own real
          // `date` to stay in the section this test is about.
          task({ id: "b", content: "b", date: "2026-08-31" }),
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

  // Issue #299/#337 removed "Postpone to tomorrow" entirely — it was
  // meologue's own divergence from Todoist, which carries exactly one
  // action on this header (Reschedule). This replaces the old
  // `describe("Postpone to tomorrow", ...)` block, which asserted the
  // button existed and worked (offered only when overdue; one tap called
  // `onPostpone` once per overdue Task) — both of those are wrong now
  // that the button is gone, so rewritten as a deliberate pin of its
  // absence rather than silently deleted.
  it("renders no 'Postpone to tomorrow' action, even when something is overdue — Todoist's header carries exactly one action", () => {
    renderTodayView({
      tasks: [task({ id: "a", content: "a", date: "2026-08-30" })],
    });

    expect(screen.queryByText("Postpone to tomorrow")).not.toBeInTheDocument();
  });

  // Issue #337: Todoist's own DOM capture has a third node on this
  // header, an `ImageView` "Expand/collapse" — overdue-section-summary.tsx
  // renders it as an `aria-hidden` chevron, not a second focusable
  // control. `closest("summary")` rather than checking accessible name
  // directly: this file's earlier note on jsdom not computing a
  // `<summary>`'s accessible name from its children still applies, so
  // this reads the DOM shape directly instead.
  it("shows an aria-hidden chevron in the Overdue summary, not a second focusable control", () => {
    renderTodayView({
      tasks: [task({ id: "late", content: "late task", date: "2026-08-30" })],
    });

    const heading = screen.getByText("Overdue");
    const summary = heading.closest("summary");
    expect(summary).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    const chevron = summary!.querySelector("svg");
    expect(chevron).not.toBeNull();
    expect(chevron).toHaveAttribute("aria-hidden", "true");
    expect(chevron?.hasAttribute("tabindex")).toBe(false);
    expect(chevron?.closest("button")).toBeNull();
    // No second name added: the summary's own DOM text is still just
    // "Overdue" plus the Reschedule button's own text — an SVG icon
    // contributes no textContent of its own.
    expect(summary?.textContent).toBe("OverdueReschedule");
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
