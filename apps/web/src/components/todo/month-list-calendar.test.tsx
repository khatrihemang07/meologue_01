import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResizeObserverStub, stubOffsetSize } from "@/test/virtualized-scroll";
import { MonthListCalendar, type MonthListCalendarProps } from "./month-list-calendar";

// Thu 10 Sep 2026, local noon — Sep 2026's own current week Monday is
// 2026-09-07 (mirrors task-schedule-popover.test.tsx's own module-level
// NOW, so a reader who knows that file's fixture recognises this one).
const NOW = new Date(2026, 8, 10, 12, 0);

/**
 * Mounts `MonthListCalendar` and gives its own scroll region a real, sized
 * viewport — `test/virtualized-scroll.ts`'s own header comment has the full
 * "why" (jsdom's virtualizer range is permanently `null` without this).
 * Individual week rows are never measured (this component never wires
 * `virtualizer.measureElement` to a row — `month-list-calendar.tsx`'s own
 * header comment on why `estimateSize` alone is already exact), so only
 * the scroll element itself needs stubbing, not every row inside it.
 */
function renderCalendar(props: Partial<MonthListCalendarProps> = {}) {
  const onPickDay = vi.fn();
  const { triggerResize } = installResizeObserverStub();
  render(
    <MonthListCalendar
      now={NOW}
      selectedDay={null}
      datesWithTasks={new Map()}
      onPickDay={onPickDay}
      {...props}
    />,
  );
  const scrollElement = screen.getByTestId("month-list-scroll");
  // 180px — issue #439's own measured visible height. `stubOffsetSize`
  // alone only fixes the viewport SIZE `@tanstack/react-virtual`'s own
  // `observeElementRect` reads (`offsetWidth`/`offsetHeight`) — a
  // SEPARATE pair, `scrollHeight`/`clientHeight`, backs `getMaxScrollOffset`
  // (behind every `scrollToIndex` call, `virtual-core`'s own source), and
  // jsdom's default `0`/`0` there clamps every scroll target down to 0
  // regardless of how far the real content extends. history.test.tsx's own
  // `scrollTo` helper stubs the identical pair for the identical reason.
  Object.defineProperty(scrollElement, "scrollHeight", { value: 999999, configurable: true });
  Object.defineProperty(scrollElement, "clientHeight", { value: 180, configurable: true });
  stubOffsetSize(scrollElement, { width: 226, height: 180 });
  act(() => triggerResize(scrollElement));
  return { onPickDay, scrollElement };
}

/**
 * Clicks a nav button and lets its own `scrollToIndex` -> `scrollTo` ->
 * (microtask) `dispatchEvent("scroll")` chain actually land — `beforeEach`'s
 * own `Element.prototype.scrollTo` polyfill defers that dispatch by one
 * microtask specifically so React's `flushSync` isn't re-entered from
 * inside the click's own event handling; `await Promise.resolve()` here is
 * what lets that deferred microtask (and the resulting re-render) run
 * before the caller asserts anything.
 */
async function clickNav(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

function dayCell(dayKey: string): HTMLElement {
  const cell = document.querySelector(`[data-day="${dayKey}"]`);
  if (cell === null) {
    throw new Error(`no cell rendered for ${dayKey}`);
  }
  return cell as HTMLElement;
}

beforeEach(() => {
  // `@tanstack/virtual-core`'s own `elementScroll` (behind `scrollToIndex`)
  // calls `Element.scrollTo`, which jsdom implements as a no-op — the same
  // polyfill history.test.tsx's own `scrollTo` helper documents needing.
  //
  // The dispatch is deliberately deferred to a microtask, NOT synchronous
  // with the `scrollTo()` call itself — a real browser's own "scroll" event
  // always arrives as a later task, never nested inside the very call stack
  // that requested the scroll. `@tanstack/react-virtual`'s own offset-
  // change handler calls React's `flushSync` when the notify is scroll-
  // driven, and `flushSync` throws/warns when it's re-entered while React
  // is already mid-update — exactly the call stack a SYNCHRONOUS dispatch
  // from inside a click handler (`fireEvent.click` -> `onClick` ->
  // `scrollToIndex` -> this polyfill) would produce. Each test that clicks
  // a nav button awaits a microtask (`await act(async () => { ...;  await
  // Promise.resolve(); })`) to let this catch up.
  Element.prototype.scrollTo = function scrollTo(
    this: Element,
    options?: ScrollToOptions | number,
  ) {
    if (typeof options === "object" && typeof options.top === "number") {
      const top = options.top;
      queueMicrotask(() => {
        this.scrollTop = top;
        this.dispatchEvent(new Event("scroll"));
      });
    }
  } as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the list's own start", () => {
  it("starts on the current week's Monday — no earlier days rendered", () => {
    renderCalendar();

    expect(document.querySelector('[data-day="2026-09-07"]')).not.toBeNull();
    expect(document.querySelector('[data-day="2026-09-06"]')).toBeNull();
    expect(document.querySelector('[data-day="2026-08-31"]')).toBeNull();
  });

  it("honours an earlier minDay bound (#442's own History caller)", () => {
    renderCalendar({ minDay: "2025-01-15" }); // a Wednesday

    // minDay's own week Monday is 2025-01-13.
    expect(document.querySelector('[data-day="2025-01-13"]')).not.toBeNull();
    expect(document.querySelector('[data-day="2025-01-12"]')).toBeNull();
  });

  it("opens scrolled to initialDay when one is given, rather than to minDay", () => {
    renderCalendar({ initialDay: "2026-12-14" }); // a Monday, 14 weeks after 7 Sep

    expect(screen.getByText("Dec 2026")).toBeInTheDocument();
  });
});

describe("virtualization — a bounded number of weeks rendered regardless of scroll depth", () => {
  it("stays bounded after jumping years into the future", () => {
    const { scrollElement } = renderCalendar();
    const atMount = document.querySelectorAll("[data-day]").length;
    expect(atMount).toBeGreaterThan(0);

    // ~5 years ahead: 5 * 52 weeks * 28px/row, give or take label rows.
    Object.defineProperty(scrollElement, "scrollHeight", {
      value: 400000,
      configurable: true,
    });
    scrollElement.scrollTop = 5 * 52 * 28;
    fireEvent.scroll(scrollElement);

    const afterJump = document.querySelectorAll("[data-day]").length;
    // Bounded, not proportional to how far the scroll travelled — a
    // regression back to a fully-materialised list would render thousands
    // of day cells here instead. ~19 overscan-padded weeks * 7 days is the
    // real steady-state count at `OVERSCAN = 6`; 300 leaves headroom
    // without weakening the actual claim (bounded, not proportional).
    expect(afterJump).toBeLessThan(300);
    expect(afterJump).toBeGreaterThan(0);
  });
});

describe("pinned month label", () => {
  it("reads the anchor week's own month at mount", () => {
    renderCalendar();
    expect(screen.getByText("Sep 2026")).toBeInTheDocument();
  });

  it("tracks the topmost week after scrolling past a month boundary", () => {
    const { scrollElement } = renderCalendar();
    Object.defineProperty(scrollElement, "scrollHeight", { value: 20000, configurable: true });
    // Weeks 0-2 (7/14/21 Sep) are 28px each, no in-list label — 84px total.
    // Week 3 (28 Sep - 4 Oct) is the one that carries Oct's own in-list
    // label, so it alone is 48px (28 + the label row). Scrolling to 90px
    // lands inside THAT week — the transition itself, not an arbitrary
    // distance past it — which is what actually exercises "the pinned
    // label reads the topmost week's own effective month," not just "a
    // large scrollTop eventually shows some later month."
    scrollElement.scrollTop = 90;
    fireEvent.scroll(scrollElement);

    expect(screen.getByText("Oct 2026")).toBeInTheDocument();
    expect(screen.queryByText("Sep 2026")).not.toBeInTheDocument();
  });
});

describe("‹ ○ › navigation", () => {
  it("‹ and ○ start disabled — the anchor week IS the current month, showing today", () => {
    renderCalendar();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Jump to today" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next month" })).toBeEnabled();
  });

  it("› scrolls to next month's start, after which ‹ and ○ become enabled", async () => {
    renderCalendar();
    await clickNav("Next month");

    expect(screen.getByText("Oct 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Jump to today" })).toBeEnabled();
  });

  it("‹ goes back a month", async () => {
    renderCalendar();
    await clickNav("Next month");
    await clickNav("Next month");
    expect(screen.getByText("Nov 2026")).toBeInTheDocument();

    await clickNav("Previous month");
    expect(screen.getByText("Oct 2026")).toBeInTheDocument();
  });

  it("‹ is disabled only at the month containing minDay, not at today's own month, when minDay is earlier", () => {
    // minDay's own month is Jan 2025; NOW is Sep 2026 — the two disagree,
    // so ‹'s own gate (minDay's month) and ○'s own gate (today's month)
    // must be independent booleans, not the same check twice.
    renderCalendar({ minDay: "2025-01-15" });

    expect(screen.getByText("Jan 2025")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
    // Not showing today's own month yet, so ○ is enabled.
    expect(screen.getByRole("button", { name: "Jump to today" })).toBeEnabled();
  });

  it("○ jumps back to today's own month and disables itself again", async () => {
    renderCalendar({ minDay: "2025-01-15" });
    await clickNav("Jump to today");

    expect(screen.getByText("Sep 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to today" })).toBeDisabled();
    // Well past minDay's own Jan 2025 now, so ‹ is enabled again.
    expect(screen.getByRole("button", { name: "Previous month" })).toBeEnabled();
  });
});

describe("day styling", () => {
  it("today is bold and reads --td-calendar-list-today, with no selected circle", () => {
    renderCalendar();
    const today = dayCell("2026-09-10");
    expect(today.className).toContain("font-bold");
    expect(today.className).toContain("text-[color:var(--td-calendar-list-today)]");
    expect(today).not.toHaveAttribute("data-selected", "true");
  });

  it("a day carrying a Task gets the busy-dot marker; a quiet day does not", () => {
    // `.style.backgroundColor` directly, not `toHaveStyle` — jest-dom's own
    // computed-style comparison doesn't reliably round-trip the bare
    // `"transparent"` keyword under jsdom, the same reason this file's own
    // sibling tests (`task-schedule-popover.test.tsx`) read `.style.*`
    // directly rather than `toHaveStyle` throughout.
    renderCalendar({ datesWithTasks: new Map([["2026-09-14", 2]]) });
    const busy = dayCell("2026-09-14");
    const quiet = dayCell("2026-09-15");
    expect(within(busy).getByTestId("busy-dot").style.backgroundColor).toBe(
      "var(--td-calendar-list-busy-dot)",
    );
    expect(within(quiet).getByTestId("busy-dot").style.backgroundColor).toBe("transparent");
  });

  it("a weekend with no Tasks is greyed; the same weekend WITH a Task is not", () => {
    // 2026-09-12 and 2026-09-19 are both Saturdays.
    renderCalendar({ datesWithTasks: new Map([["2026-09-19", 1]]) });
    const quietWeekend = dayCell("2026-09-12");
    const busyWeekend = dayCell("2026-09-19");
    expect(quietWeekend.className).toContain("text-[color:var(--td-calendar-list-weekday)]");
    expect(busyWeekend.className).not.toContain("text-[color:var(--td-calendar-list-weekday)]");
  });

  it("an ordinary day (no special state) carries no special colour override", () => {
    renderCalendar();
    const ordinary = dayCell("2026-09-08"); // a plain Tuesday
    expect(ordinary.className).not.toContain("--td-calendar-list-today");
    expect(ordinary.className).not.toContain("--td-calendar-list-selected");
    expect(ordinary.className).not.toContain("--td-calendar-list-weekday");
  });

  it("the selected day is a filled circle — bg --td-calendar-list-selected, white text", () => {
    renderCalendar({ selectedDay: "2026-09-08" });
    const selected = dayCell("2026-09-08");
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(selected.className).toContain("bg-[color:var(--td-calendar-list-selected)]");
    expect(selected.className).toContain("text-white");
  });

  it("a selectedDay before minDay is never painted — it simply never appears in the list", () => {
    renderCalendar({ selectedDay: "2026-08-01" });
    expect(document.querySelector('[data-selected="true"]')).toBeNull();
  });
});

describe("day hover — replaces the weekday row with an info line", () => {
  it("shows the weekday row by default, with the hover info line absent", () => {
    renderCalendar();
    expect(screen.getByTestId("month-list-weekday-row")).toBeInTheDocument();
    expect(screen.queryByTestId("month-list-hover-info")).not.toBeInTheDocument();
  });

  it("swaps to the hover info line for the hovered day, and back on mouse leave", () => {
    renderCalendar({ datesWithTasks: new Map([["2026-09-09", 3]]) });
    fireEvent.mouseEnter(dayCell("2026-09-09"));

    expect(screen.queryByTestId("month-list-weekday-row")).not.toBeInTheDocument();
    const info = screen.getByTestId("month-list-hover-info");
    expect(info.textContent).toContain("Wed 9 Sep");
    expect(within(info).getByText("3 tasks")).toBeInTheDocument();

    fireEvent.mouseLeave(dayCell("2026-09-09"));
    expect(screen.getByTestId("month-list-weekday-row")).toBeInTheDocument();
    expect(screen.queryByTestId("month-list-hover-info")).not.toBeInTheDocument();
  });
});

describe("picking a day", () => {
  it("commits immediately — no separate confirm step", () => {
    const { onPickDay } = renderCalendar();
    fireEvent.click(dayCell("2026-09-09"));
    expect(onPickDay).toHaveBeenCalledWith("2026-09-09");
    expect(onPickDay).toHaveBeenCalledTimes(1);
  });
});
