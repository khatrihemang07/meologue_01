import type { Task } from "@meologue/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { swipeDown, swipeLeft } from "@/test/swipe";
import { installResizeObserverStub, stubOffsetSize } from "@/test/virtualized-scroll";
import { UpcomingView } from "./upcoming-view";

/**
 * Issue #439's own `MonthListCalendar` (behind Reschedule's own
 * `TaskSchedulePopover`) is virtualized, unlike the react-day-picker grid
 * it replaced — no day cell renders at all until the scroll element's own
 * viewport has a real, non-zero size (`month-list-calendar.test.tsx`'s own
 * `renderCalendar` helper documents the full mechanism: jsdom's virtualizer
 * range is permanently `null` without it).
 *
 * `installResizeObserverStub()` has to run BEFORE `openPopover` — the
 * calendar constructs its own real `ResizeObserver` the moment it mounts,
 * against whichever `ResizeObserver` CLASS is the current global at that
 * exact instant (`src/test/setup.ts`'s own file-wide `NoOpResizeObserver`
 * by default). Swapping in a different stub class AFTER that construction
 * — installing it only once the popover is already open — does nothing:
 * the already-constructed instance stays bound to whichever class built
 * it, and the new stub's own `triggerResize` has no handle on an instance
 * it never tracked. `beforeAll`'s own one-off warm-up stub, above, is a
 * different instance again, discarded once that call returns — neither it
 * nor `setup.ts`'s default can be triggered by hand at all.
 */
function stubMonthListViewport(openPopover: () => void) {
  const { triggerResize } = installResizeObserverStub();
  openPopover();
  const scrollElement = screen.getByTestId("month-list-scroll");
  stubOffsetSize(scrollElement, { width: 226, height: 180 });
  triggerResize(scrollElement);
}

/** The `[data-task-row-box]` `<div>` inside the row that renders `label` — the element `use-swipe-actions.ts` picks up, same as task-tree.test.tsx's identical helper. */
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

/**
 * `wrap` (default identity): lets one test — the `<summary>` no-collapse
 * guard below — mount `UpcomingView` inside its own ancestor with an
 * `onClick` of its own, so it can tell whether a click's own
 * `stopPropagation()` reaches that ancestor. Every other caller omits it.
 */
function renderUpcomingView(
  overrides: Partial<Parameters<typeof UpcomingView>[0]> = {},
  wrap: (ui: ReactElement) => ReactElement = (ui) => ui,
) {
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
    onSetDateString: vi.fn(),
    ...overrides,
  };
  render(wrap(<UpcomingView {...props} />));
  return props;
}

// Issue #416: `TaskSchedulePopover` sits behind `LazyTaskSchedulePopover`
// now (a `React.lazy()` singleton, one module-level promise shared by every
// render in this file). Its first-ever resolution needs a real Promise
// microtask *and* a React scheduler callback to re-render the Suspense
// boundary — and once this suite's own `beforeEach` below swaps in
// `vi.useFakeTimers()`, that scheduler callback is captured against the
// faked timer APIs and never fires again, even from a test that later
// calls `vi.useRealTimers()` mid-test (confirmed empirically: switching
// back after the fact does not unstick an already-broken retry, only
// resolving it beforehand does). This primes that first resolution here,
// under real timers, before any test's `beforeEach` ever runs — every
// fake-timer test after this one renders the already-resolved component
// synchronously, with no Suspense retry needed at all.
beforeAll(async () => {
  // Issue #440: `TaskSchedulePopover`'s own desktop placement now
  // constructs a real `ResizeObserver` the moment it opens — `src/test/
  // setup.ts`'s own file-wide `NoOpResizeObserver` (its own header
  // comment) covers every ordinary test via its `beforeEach`, but this
  // warm-up runs in `beforeAll`, before any `beforeEach` — this file's
  // own — has had a chance to run at all.
  installResizeObserverStub();
  renderUpcomingView({
    tasks: [task({ id: "warm-lazy-schedule-popover", content: "warm task", date: "2026-09-01" })],
  });
  swipeLeft(rowBox("warm task"));
  await waitFor(() => expect(screen.getByTestId("scheduler-view")).toBeInTheDocument(), {
    timeout: 5000,
  });
  cleanup();
});

describe("UpcomingView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0)); // Sep 10, 2026, local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads an explanatory empty state, not a blank panel, when nothing is dated today or later", () => {
    renderUpcomingView({ tasks: [] });

    expect(screen.getByText("Nothing scheduled")).toBeInTheDocument();
  });

  // Issue #299 reverses this: meologue used to keep an overdue Task in
  // Today only, "never doubled into both views" (task-views.ts's own
  // upcoming() header comment has the fuller history). Todoist doubles
  // it — the same Task shows in Today's Overdue section AND here — so
  // this assertion now inverts what it checked before #299: previously
  // "excludes an overdue Task — that's Today's section, not Upcoming's,"
  // asserting `queryByText("late task")).not.toBeInTheDocument()` and
  // `getByText("Nothing scheduled")`.
  it("shows an overdue Task in its own Overdue section — Todoist doubles it into Today and Upcoming, not Today only", () => {
    renderUpcomingView({
      tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })],
    });

    expect(screen.getByText("late task")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByText("Nothing scheduled")).not.toBeInTheDocument();
  });

  // The owner's own read of Todoist's reference screenshots (a40-32-
  // upcoming.png, a03-todoist-today.png): the header is bare "Overdue",
  // no count — unlike this app's usual "Section (count)" convention
  // (compare the day headings' own "10 Sep ‧ Today ‧ Thursday", which
  // carries no count either, and TodayView's "Overdue (N)", which is
  // *not* what this section copies). A first cut of this section read
  // "Overdue (1)"/"Overdue (2)" — pinned here so a count can't creep
  // back in.
  it("pins the bare 'Overdue' header text — no digits, unlike TodayView's own 'Overdue (N)'", () => {
    renderUpcomingView({
      tasks: [
        task({ id: "late-1", content: "late task one", date: "2026-09-01" }),
        task({ id: "late-2", content: "late task two", date: "2026-08-20" }),
      ],
    });

    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByText(/Overdue\s*\(\d+\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Overdue\s*\d/)).not.toBeInTheDocument();
  });

  it("renders every overdue Task under the one Overdue section, ahead of the day sections", () => {
    renderUpcomingView({
      tasks: [
        task({ id: "late-1", content: "late task one", date: "2026-09-01" }),
        task({ id: "late-2", content: "late task two", date: "2026-08-20" }),
        task({ id: "today", content: "today task", date: "2026-09-10" }),
      ],
    });

    expect(screen.getByText("late task one")).toBeInTheDocument();
    expect(screen.getByText("late task two")).toBeInTheDocument();
    expect(screen.getAllByText("Overdue")).toHaveLength(1);

    // Ahead of the day sections: the Overdue heading's own text precedes
    // the first day heading's in document order.
    const overdueIndex = document.body.innerHTML.indexOf(">Overdue<");
    const todayHeadingIndex = document.body.innerHTML.indexOf("10 Sep");
    expect(overdueIndex).toBeGreaterThanOrEqual(0);
    expect(todayHeadingIndex).toBeGreaterThan(overdueIndex);
  });

  // Before #375, today()'s own overdue bucket (reused here) surfaced a
  // Deadline-only Task with no date at all. Deadline is never read now
  // (D12: Pro-gated in Todoist, 0 Tasks carry one in either live
  // database), so an undated Task never reaches this bucket regardless of
  // its deadline.
  it("does not reuse today()'s own overdue bucket for a Deadline-only Task (no date at all) — #375", () => {
    renderUpcomingView({
      tasks: [
        task({
          id: "deadline-only",
          content: "deadline only task",
          date: null,
          deadline: "2026-09-01",
        }),
      ],
    });

    expect(screen.queryByText("deadline only task")).not.toBeInTheDocument();
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
  });

  it("renders the Overdue heading inside a native <details> disclosure, not a plain <section>/<h2>", () => {
    renderUpcomingView({
      tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })],
    });

    const heading = screen.getByText("Overdue");
    const summary = heading.closest("summary");
    expect(summary).not.toBeNull();
    const disclosure = summary?.closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).toHaveAttribute("open");
  });

  // Asserts the CONTRAST, not just the absence. An absence-only version of
  // this test passes against `main`, where UpcomingView never renders an
  // Overdue section at all — it would be green whether or not this feature
  // exists, which is no evidence about the gate it claims to check. Driving
  // both states in one test makes the presence half fail on revert.
  it("renders the Overdue section only when something is overdue", () => {
    renderUpcomingView({
      tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })],
    });
    expect(screen.getByText("Overdue")).toBeInTheDocument();

    cleanup();
    renderUpcomingView({
      tasks: [task({ id: "today", content: "today task", date: "2026-09-10" })],
    });
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
  });

  // Issue #337: Todoist's own DOM capture has a third node on this
  // header, an `ImageView` "Expand/collapse" — overdue-section-summary.tsx
  // renders it as an `aria-hidden` chevron, not a second focusable
  // control, shared verbatim with TodayView's own Overdue section
  // (today-view.test.tsx's own identical test has the fuller reasoning).
  it("shows an aria-hidden chevron in the Overdue summary, not a second focusable control", () => {
    renderUpcomingView({
      tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })],
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
    expect(summary?.textContent).toBe("OverdueReschedule");
  });

  // Todoist's own only action on this header (the owner's ratified
  // correction, issue #299) — reuses overdue-reschedule-action.tsx, the
  // identical implementation TodayView's own Reschedule button now calls
  // (today-view.test.tsx's own "Reschedule" describe block has the
  // fuller confirm-flow reasoning), not a second scheduler path written
  // here.
  describe("Reschedule (Todoist's only action on the Overdue header)", () => {
    // Contrast, for the same reason the Overdue-section test above states:
    // asserting only the absence is green against `main` too.
    it("offers the Reschedule action only when something is overdue", () => {
      renderUpcomingView({
        tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })],
      });
      expect(screen.getByRole("button", { name: "Reschedule" })).toBeInTheDocument();

      cleanup();
      renderUpcomingView({
        tasks: [task({ id: "today", content: "today task", date: "2026-09-10" })],
      });
      expect(screen.queryByRole("button", { name: "Reschedule" })).not.toBeInTheDocument();
    });

    // Issue #337 — the identical token-pinning test today-view.test.tsx's
    // own "Reschedule" describe block has, verifying the shared component
    // reached this view too, not a second, divergent styling.
    it("reads its text colour from the --td-overdue-reschedule token, not a literal colour", () => {
      renderUpcomingView({
        tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })],
      });

      const button = screen.getByRole("button", { name: "Reschedule" });
      expect(button.style.color).toBe("var(--td-overdue-reschedule)");
    });

    // Issue #435: Reschedule now opens the identical `TaskSchedulePopover`
    // a Task's own Date button opens, not the old tap-then-Confirm
    // `DatePickerSheet` — today-view.test.tsx's own "Reschedule" describe
    // block has the fuller per-behaviour tests (day-pick preserving time
    // and Recurrence, bulk Time, bulk Recurrence, No Date); this one test
    // proves the identical wiring reaches Upcoming too.
    it("picking a day moves every overdue Task, keeping each one's own time and Recurrence untouched", () => {
      const onSetDate = vi.fn();
      const onSetDateString = vi.fn();
      renderUpcomingView({
        tasks: [
          task({ id: "a", content: "a", date: "2026-08-30T21:00" }),
          task({ id: "b", content: "b", date: "2026-08-31", dateString: "every day" }),
        ],
        onSetDate,
        onSetDateString,
      });

      stubMonthListViewport(() =>
        fireEvent.click(screen.getByRole("button", { name: "Reschedule" })),
      );
      fireEvent.click(document.querySelector('[data-day="2026-09-20"]') as HTMLElement);

      expect(onSetDate).toHaveBeenCalledTimes(2);
      expect(onSetDate).toHaveBeenCalledWith("a", "2026-09-20T21:00");
      expect(onSetDate).toHaveBeenCalledWith("b", "2026-09-20");
      expect(onSetDateString).not.toHaveBeenCalled();
    });

    // Issue #435's own acceptance criterion: the calendar's busy-day marks
    // are the same real Task data a Task's own picker reads. This view
    // has its own `datesWithTasks` wiring (`detailActions.datesWithTasks`,
    // threaded through `OverdueSectionSummary` the same way TodayView's
    // own identical test proves) — checked here too, not assumed shared.
    it("the calendar's busy-day marks reflect the real datesWithTasks map, not just the overdue Tasks", () => {
      renderUpcomingView({
        tasks: [task({ id: "a", content: "a", date: "2026-09-01" })],
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map([["2026-09-20", 3]]),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });

      stubMonthListViewport(() =>
        fireEvent.click(screen.getByRole("button", { name: "Reschedule" })),
      );

      const busyCell = document.querySelector('[data-day="2026-09-20"]') as HTMLElement;
      const quietCell = document.querySelector('[data-day="2026-09-21"]') as HTMLElement;
      expect(within(busyCell).getByTestId("busy-dot").style.backgroundColor).toBe(
        "var(--td-calendar-list-busy-dot)",
      );
      expect(within(quietCell).getByTestId("busy-dot").style.backgroundColor).toBe("transparent");
    });

    // overdue-reschedule-action.tsx's own `event.stopPropagation()` guards
    // against a real browser's native <summary> toggling its <details> on
    // any bubbled click, Reschedule's own click included — but jsdom does
    // not reproduce that native toggle-on-bubbled-click behaviour at all
    // (fireEvent.click here never collapses a <details> either way, guard
    // or no guard), so no test can observe THAT outcome directly. What
    // jsdom's own event system does reproduce correctly is React's own
    // synthetic bubbling — a `stopPropagation()` call inside a click
    // handler reliably keeps an ANCESTOR component's own `onClick` from
    // firing for that same click, in jsdom exactly as in a real browser —
    // so this test proves the guard's actual mechanism (the click stops
    // there) rather than its real-browser consequence (the section stays
    // open), the same way `isOwnedPortalTarget`'s own tests in
    // task-schedule-popover.test.tsx prove a classification rather than
    // the Radix dismiss race it feeds.
    it("stops the Reschedule click from reaching an ancestor's own onClick, the mechanism the real <summary> guard needs", () => {
      const onAncestorClick = vi.fn();
      renderUpcomingView(
        { tasks: [task({ id: "late", content: "late task", date: "2026-09-01" })] },
        // biome-ignore lint/a11y/noStaticElementInteractions: this stand-in ancestor only exists to prove the click doesn't bubble to it; it isn't a real row.
        // biome-ignore lint/a11y/useKeyWithClickEvents: same reason.
        (ui) => <div onClick={onAncestorClick}>{ui}</div>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));

      expect(onAncestorClick).not.toHaveBeenCalled();
      // The guard doesn't come at the cost of the picker itself opening.
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });
  });

  it("headings read exactly '10 Sep ‧ Today ‧ Thursday' and '11 Sep ‧ Tomorrow ‧ Friday'", () => {
    renderUpcomingView({
      tasks: [
        task({ id: "today", content: "today task", date: "2026-09-10" }),
        task({ id: "tomorrow", content: "tomorrow task", date: "2026-09-11" }),
      ],
    });

    expect(screen.getByText("10 Sep ‧ Today ‧ Thursday")).toBeInTheDocument();
    expect(screen.getByText("11 Sep ‧ Tomorrow ‧ Friday")).toBeInTheDocument();
  });

  it("a day beyond tomorrow gets a weekday-only heading, no relative word", () => {
    renderUpcomingView({
      tasks: [task({ id: "later", content: "later task", date: "2026-09-12" })],
    });

    expect(screen.getByText("12 Sep ‧ Saturday")).toBeInTheDocument();
  });

  it("renders each day's Tasks under its own section, in chronological day order", () => {
    renderUpcomingView({
      tasks: [
        task({ id: "later", content: "later task", date: "2026-09-12" }),
        task({ id: "today", content: "today task", date: "2026-09-10" }),
      ],
    });

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["10 Sep ‧ Today ‧ Thursday", "12 Sep ‧ Saturday"]);
  });

  // Issue #303: reuses `use-swipe-actions.ts`'s shared recogniser, attached
  // once to this view's own outer wrapper — the identical reasoning
  // today-view.tsx's own header comment on its identical wiring gives:
  // every day-section renders its own separate `<ul>`, with no ancestor
  // narrower than that wrapper common to all of them.
  describe("swipe-to-schedule (issue #303)", () => {
    it("opens the swiped row's own schedule popover", () => {
      renderUpcomingView({
        tasks: [
          task({ id: "later", content: "later task", date: "2026-09-12" }),
          task({ id: "today", content: "today task", date: "2026-09-10" }),
        ],
      });

      swipeLeft(rowBox("later task"));

      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    it("does not open anything for a vertical drag", () => {
      renderUpcomingView({
        tasks: [task({ id: "today", content: "today task", date: "2026-09-10" })],
      });

      swipeDown(rowBox("today task"));

      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });
  });

  // Issue #343: the week strip itself. jsdom implements neither the
  // `scrollIntoView` property nor method at all (task-custom-repeat-
  // dialog.tsx's own header comment names this exact class of trap for a
  // sibling API) — a real call would throw here, which is why
  // upcoming-view.tsx's own `handleSelectDay` reads it with `?.`. That
  // same absence is also why this suite cannot observe an actual scroll:
  // it stubs the method, then asserts WHICH element it was called on
  // (`mock.contexts`, the call's own `this`) — proof the right dayKey was
  // targeted, not proof anything moved on screen. The real scroll motion
  // is unverified outside a browser; see this file's own report to the
  // issue for that flag restated in full.
  describe("the week strip (issue #343)", () => {
    let scrollIntoView: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollIntoView = vi.fn();
      // jsdom's own HTMLElement has no scrollIntoView property to type
      // against at all (this block's own header comment) — there is no
      // narrower type than `any` to reach for here.
      // biome-ignore lint/suspicious/noExplicitAny: see comment above.
      (HTMLElement.prototype as any).scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      // Removing the stub restores jsdom's own "not implemented" state so
      // no other test file inherits it. Cast to `Partial<HTMLElement>`
      // (rather than `undefined`, which would leave
      // `"scrollIntoView" in HTMLElement.prototype` true, unlike jsdom's
      // own real absence) so `delete` type-checks without a second `any`.
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });

    it("renders all seven days of the strip above the day sections, Thursday (today) at index 3", () => {
      renderUpcomingView({
        tasks: [task({ id: "today", content: "today task", date: "2026-09-10" })],
      });

      const dayButtons = screen
        .getAllByRole("button")
        .filter((b) => b.hasAttribute("data-day-key"));
      expect(dayButtons.map((b) => b.getAttribute("data-day-key"))).toEqual([
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
        "2026-09-12",
        "2026-09-13",
      ]);
    });

    it("tapping a day WITH a section scrolls exactly that section into view", () => {
      renderUpcomingView({
        tasks: [
          task({ id: "today", content: "today task", date: "2026-09-10" }),
          task({ id: "later", content: "later task", date: "2026-09-12" }),
        ],
      });

      fireEvent.click(screen.getByRole("button", { name: /Saturday 12/ }));

      const target = document.querySelector('[data-upcoming-day-anchor="2026-09-12"]');
      expect(target).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(target);
    });

    // The trap this issue's own tracking comment names: `upcoming()` never
    // returns a day with nothing dated on it, so there is no `<section>`
    // for a tap on Monday (this fixture's set has nothing dated Monday)
    // to scroll to unless upcoming-view.tsx renders an anchor for it
    // separately — proving that seam exists, not merely that upcoming()
    // itself is unaffected (the sidebar/todo-page proof below covers that
    // half).
    it("tapping an EMPTY day (no section at all) still scrolls to a real, addressable node", () => {
      renderUpcomingView({
        tasks: [task({ id: "today", content: "today task", date: "2026-09-10" })],
      });

      fireEvent.click(screen.getByRole("button", { name: /Monday 7/ }));

      const target = document.querySelector('[data-upcoming-day-anchor="2026-09-07"]');
      expect(target).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(target);
    });

    it("every one of the strip's seven days stays addressable even in the 'Nothing scheduled' empty state", () => {
      renderUpcomingView({ tasks: [] });
      expect(screen.getByText("Nothing scheduled")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Friday 11/ }));

      const target = document.querySelector('[data-upcoming-day-anchor="2026-09-11"]');
      expect(target).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(target);
    });

    it("selecting a day updates the strip's own selected circle — the fill moves off today", () => {
      renderUpcomingView({
        tasks: [task({ id: "today", content: "today task", date: "2026-09-10" })],
      });

      fireEvent.click(screen.getByRole("button", { name: /Saturday 12/ }));

      const saturday = screen.getByRole("button", { name: /Saturday 12/ });
      const circle = saturday.querySelector(
        '[aria-hidden="true"].rounded-full.font-medium',
      ) as HTMLElement;
      expect(circle.style.backgroundColor).toBe("var(--td-calendar-selected)");

      // Today's own circle is no longer filled now that Saturday is selected.
      const today = screen.getByRole("button", { name: /Thursday 10, today/ });
      const todayCircle = today.querySelector(
        '[aria-hidden="true"].rounded-full.font-medium',
      ) as HTMLElement;
      expect(todayCircle.style.backgroundColor).toBe("");
      expect(todayCircle.style.color).toBe("var(--td-calendar-today)");
    });

    it("jumping back to today re-selects it and scrolls to today's own section", () => {
      renderUpcomingView({
        tasks: [task({ id: "today", content: "today task", date: "2026-09-10" })],
      });

      fireEvent.click(screen.getByRole("button", { name: /Saturday 12/ }));
      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));

      const target = document.querySelector('[data-upcoming-day-anchor="2026-09-10"]');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(target);
    });
  });
});
