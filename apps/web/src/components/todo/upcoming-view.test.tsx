import type { Task } from "@meologue/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("UpcomingView", () => {
  // Pinned to the reference capture's own "today" (meologue-reference/todoist/
  // README.md: 10 Sep 2026, a Thursday) so every heading this suite reads
  // matches DATE-05's own wording verbatim, mirroring TodayView's own
  // fixed-clock reasoning (today-view.test.tsx's header comment).
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

  it("reuses today()'s own overdue bucket — a Deadline-only overdue Task (no date at all) still appears here", () => {
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

    expect(screen.getByText("deadline only task")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  // `closest("summary")`/`closest("details")` rather than
  // `getByRole("button", { name })`: task-detail-view.test.tsx's own
  // Comments disclosure test hits the identical limitation (its CMT-10
  // describe block's own comment) — a `<details>` does take the
  // accessible role, but testing-library does not compute an accessible
  // name from its `<summary>` child, so a named role query can't find it
  // here even though a real browser's own accessibility tree exposes the
  // `<summary>` itself as role "button".
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
});
