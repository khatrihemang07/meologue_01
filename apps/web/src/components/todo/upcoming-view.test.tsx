import type { Task } from "@meologue/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { swipeDown, swipeLeft } from "@/test/swipe";
import { UpcomingView } from "./upcoming-view";

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

function renderUpcomingView(overrides: Partial<Parameters<typeof UpcomingView>[0]> = {}) {
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
  render(<UpcomingView {...props} />);
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

    it("rescheduling sets the date of every overdue Task to the chosen day, and touches nothing else", () => {
      const onSetDate = vi.fn();
      renderUpcomingView({
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

    // NOT tested here: overdue-reschedule-action.tsx's own
    // `event.stopPropagation()` guards against a real browser's native
    // <summary> toggling its <details> on any bubbled click, Reschedule's
    // own click included. Mutation-tested that guard by deleting the
    // `stopPropagation()` call and re-running this file: nothing failed
    // — jsdom does not reproduce that toggle-on-bubbled-click behaviour
    // (fireEvent.click here never collapses the disclosure either way),
    // so no test in this file can discriminate the guard's presence.
    // The `stopPropagation()` call stays, for the real-browser behaviour
    // its own comment documents, but is only verifiable by driving an
    // actual browser — flagging for that pass rather than keeping a test
    // that would pass with the guard deleted.
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
