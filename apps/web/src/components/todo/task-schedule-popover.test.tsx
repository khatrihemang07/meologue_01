import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WIDE_LAYOUT_QUERY } from "@/hooks/use-wide-layout";
// `import * as`, not a named import: `vi.spyOn` needs the module namespace
// object itself to intercept a call task-schedule-popover.tsx makes to its
// own named import of the same function — the identical pattern entry-
// row.test.tsx's own `entryDayModule` already uses for the same reason.
import * as schedulePopoverPlacement from "@/lib/schedule-popover-placement";
import { installResizeObserverStub } from "@/test/virtualized-scroll";
import { isOwnedPortalTarget, TaskSchedulePopover } from "./task-schedule-popover";

/**
 * Issue #440: the desktop popover's own placement effect (task-schedule-
 * popover.tsx) constructs a real `ResizeObserver` the moment it opens, to
 * re-measure the card whenever its own size changes. `src/test/setup.ts`'s
 * own file-wide `NoOpResizeObserver` already keeps that constructor from
 * throwing everywhere (its own header comment: this exact fix is what
 * surfaced the need for it, in dozens of files besides this one) — this
 * file's own installation on top of that default is only for the tests
 * that actually want to fire one (`triggerResize`, read by
 * `stubDesktopMeasurements` below), overriding the global no-op for the
 * duration of each test here.
 */
let resizeObserverStub: ReturnType<typeof installResizeObserverStub> | null = null;

beforeEach(() => {
  resizeObserverStub = installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = new Date(2026, 8, 10, 12, 0); // Thu 10 Sep 2026, local noon
// Issue #436's own "Later this week" rule (`laterThisWeekDay`, task-
// schedule-popover.tsx) needs a `now` where the measured example itself
// lands clean (Mon -> Wed, no weekend clamp) — `NOW` above is a Thursday,
// which exercises the clamp's own known collision-with-Tomorrow edge case
// instead (that file's own header comment on `laterThisWeekDay`; this
// suite's own dedicated test for it, below). Sep 2026 starts on a Tuesday
// (this file's own pre-existing calendar test), so the 7th is a Monday.
const MONDAY_NOW = new Date(2026, 8, 7, 12, 0); // Mon 7 Sep 2026, local noon

/**
 * Pins which shell the component renders in (issue #282; moved off width
 * onto touch capability by issue #365 — see `touchOnlyDevice()`'s own
 * comment).
 *
 * `test/setup.ts`'s global stub answers `false` to every query but
 * `(hover: hover)`, which is now exactly `touchOnlyDevice()`'s own "not
 * touch-only" default — so without this, every test below silently
 * exercises the *popover* rather than either sheet variant. (Issue #282's
 * own trap ran the other way, when the component still read width: all 59
 * assertions in this file kept passing while testing the wrong shell,
 * because they query by `data-testid="scheduler-view"` and by role, and
 * both shells satisfy both.) Assert the property, not the difference — and
 * state which shell you meant.
 */
function stubLayout(popover: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: popover
        ? query === "(hover: hover)"
        : query === "(pointer: coarse)" || query === "(hover: none)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

/**
 * Issue #365's own regression shape: stubs pointer/hover *and* the
 * wide-layout breakpoint independently, so a test can put them in the
 * combination that used to be impossible to express — a touch device at a
 * wide viewport, or a non-touch device (Tauri's coarse-pointer misreport
 * included) at a narrow one — and show the shell follows touch, not width.
 */
function stubTouchAtWidth(touch: boolean, wideViewport: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      if (query === WIDE_LAYOUT_QUERY) {
        // Stubbed to the opposite of what the shell choice would need if it
        // still read width, so a test that passes can only be passing
        // because the component stopped asking.
        return { matches: wideViewport } as MediaQueryList;
      }
      const matches = touch
        ? query === "(pointer: coarse)" || query === "(hover: none)"
        : // Tauri's real misreport (D4/#365): a coarse pointer with hover
          // still present. Included on the non-touch branch so the "desktop
          // behaviour survives width alone" test exercises that guard too,
          // not just a plain mouse.
          query === "(hover: hover)" || query === "(pointer: coarse)";
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  );
}

function renderPopover(props: Partial<Parameters<typeof TaskSchedulePopover>[0]> = {}) {
  const onPickDay = vi.fn();
  const onPickRecurrence = vi.fn();
  const onSetTime = vi.fn();
  render(
    <TaskSchedulePopover
      trigger={<button type="button">Pick a date</button>}
      dateDay={null}
      dateTime={null}
      onSetTime={onSetTime}
      dateString={null}
      datesWithTasks={new Map()}
      now={NOW}
      onPickDay={onPickDay}
      onPickRecurrence={onPickRecurrence}
      {...props}
    />,
  );
  return { onPickDay, onPickRecurrence, onSetTime };
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Pick a date" }));
}

/**
 * Issue #440's desktop placement measures two real DOM nodes at open time
 * — the trigger (`getBoundingClientRect()`, its position) and the popover
 * card itself (`offsetWidth`/`offsetHeight`, its real laid-out size — NOT
 * `getBoundingClientRect()`, deliberately: that reports the card's visual,
 * post-transform box, and Radix's own Popper wrapper transforms it while
 * still positioning it; `task-schedule-popover.tsx`'s own comment above its
 * placement effect has the full defect this was fixed for) — plus
 * `window.innerWidth`/`innerHeight`. jsdom lays nothing out (`virtualized-
 * scroll.ts`'s own header comment: every element's box reads all-zero,
 * forever), so all three have to be stubbed by hand for this component's
 * own placement math to have anything real to react to. Keyed by identity
 * (`el === triggerEl`) rather than a selector, since the trigger is
 * whatever `renderPopover`'s own `trigger` prop rendered — a plain
 * `<button>` in every test here — and the card is found by its own
 * `data-testid` once open.
 *
 * The card's own size — and the trigger's own rect — are read from mutable
 * boxes, not fixed values: issue #440's own fix needs tests that change
 * what's reported mid-test (the card's real height landing after a short
 * first reading; the trigger's own rect moving, standing in for a page
 * scroll) and observe this component react — `setCardSize`/`setTrigger`
 * are those seams. `installResizeObserverStub` (`@/test/virtualized-
 * scroll`, this codebase's own stand-in for jsdom's total absence of a
 * real `ResizeObserver`) is installed unconditionally here, not only by
 * callers that need to fire one by hand: `task-schedule-popover.tsx`'s own
 * effect constructs a real `ResizeObserver` the moment the desktop popover
 * opens, which throws in plain jsdom with nothing else in this file's own
 * `afterEach` currently restoring `vi.unstubAllGlobals()` —
 * `desktop popover placement`'s own `afterEach` (below) is what does.
 */
function stubDesktopMeasurements({
  trigger,
  card,
  viewport,
}: {
  trigger: { top: number; left: number; width: number; height: number };
  card: { width: number; height: number };
  viewport: { width: number; height: number };
}): {
  setCardSize: (size: { width: number; height: number }) => void;
  setTrigger: (rect: { top: number; left: number; width: number; height: number }) => void;
  triggerResize: (target: Element) => void;
} {
  Object.defineProperty(window, "innerWidth", {
    value: viewport.width,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: viewport.height,
    configurable: true,
  });
  let triggerRect = trigger;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === screen.queryByRole("button", { name: "Pick a date" })) {
      return {
        top: triggerRect.top,
        left: triggerRect.left,
        bottom: triggerRect.top + triggerRect.height,
        right: triggerRect.left + triggerRect.width,
        width: triggerRect.width,
        height: triggerRect.height,
        x: triggerRect.left,
        y: triggerRect.top,
        toJSON: () => ({}),
      };
    }
    return {
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
  let cardSize = card;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("data-testid") === "scheduler-view" ? cardSize.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("data-testid") === "scheduler-view" ? cardSize.height : 0;
  });
  return {
    setCardSize(size) {
      cardSize = size;
    },
    setTrigger(rect) {
      triggerRect = rect;
    },
    triggerResize(target) {
      // Non-null by construction: the file-wide `beforeEach` above always
      // runs before any test's own body does.
      resizeObserverStub?.triggerResize(target);
    },
  };
}

describe("shell by touch capability (issue #282, moved off width by #365)", () => {
  it("renders an anchored popover on a non-touch device", () => {
    stubLayout(true);
    renderPopover();
    open();

    const view = screen.getByTestId("scheduler-view");
    expect(view.getAttribute("data-slot")).toBe("popover-content");
    // Not asserted by role: Radix gives `Popover.Content` `role="dialog"`
    // too, so role tells the two shells apart not at all. `data-slot` is the
    // only thing that actually discriminates, which is the whole reason the
    // 59 assertions below could run against the wrong shell and pass.
    expect(screen.queryByText("Date")).toBeNull();
  });

  it("renders a bottom sheet on a touch-only device", () => {
    stubLayout(false);
    renderPopover();
    open();

    const view = screen.getByTestId("scheduler-view");
    expect(view.getAttribute("data-slot")).toBe("sheet-content");
    expect(screen.getByRole("dialog")).toBe(view);
  });

  it("gives the sheet a visible Date title, as Todoist Android's has", () => {
    stubLayout(false);
    renderPopover();
    open();

    const heading = screen.getByText("Date");
    expect(heading.getAttribute("data-slot")).toBe("sheet-title");
    expect(screen.getByRole("dialog", { name: "Date" })).toBeTruthy();
  });

  it("offers the same quick options in both shells", () => {
    // The two shells share one `scheduleFields` tree precisely so they cannot
    // drift; this is the assertion that holds that shut.
    // Scoped `within` the scheduler, not the whole screen: the sheet is a
    // modal Dialog, so Radix marks everything outside it `aria-hidden` and
    // the trigger drops out of the accessibility tree — a real difference
    // between the shells, and not one about the options themselves.
    const optionsIn = () =>
      within(screen.getByTestId("scheduler-view"))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");

    stubLayout(true);
    renderPopover();
    open();
    const wide = optionsIn();

    cleanup();

    stubLayout(false);
    renderPopover();
    open();
    const narrow = optionsIn();

    // The sheet adds its own title element but no extra controls.
    expect(narrow).toEqual(wide);
    expect(wide.length).toBeGreaterThan(4);
  });

  it("gives a touch device the sheet even at a wide (>=900px) viewport", () => {
    stubTouchAtWidth(true, true);
    renderPopover();
    open();

    const view = screen.getByTestId("scheduler-view");
    expect(view.getAttribute("data-slot")).toBe("sheet-content");
  });

  it("gives a Tauri desktop window at 800px the popover, not the sheet", () => {
    // Tauri opens at 800px (`apps/macos/tauri.conf.json`'s own `width: 800`)
    // and can misreport a coarse pointer for its trackpad — the exact case
    // `touchOnlyDevice()` guards with `(hover: none)`, and the exact case a
    // width-only rule would get wrong.
    stubTouchAtWidth(false, false);
    renderPopover();
    open();

    const view = screen.getByTestId("scheduler-view");
    expect(view.getAttribute("data-slot")).toBe("popover-content");
  });
});

describe("an already-recurring Task (issue #293)", () => {
  beforeEach(() => {
    stubLayout(true);
  });

  const RECURRING = { dateDay: "2026-09-10", dateString: "every day" };

  it("names the trigger for the rule instead of 'Repeat'", () => {
    renderPopover(RECURRING);
    open();

    // Todoist labels the control with the rule's own name once one is set,
    // and CONTEXT.md's Recurrence entry says the stored phrase is what the
    // user typed — so this is the stored phrase, capitalised, not a
    // re-derived description of it.
    expect(screen.getByRole("button", { name: "Every day" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repeat" })).toBeNull();
  });

  it("offers a Clear recurrence button beside it", () => {
    renderPopover(RECURRING);
    open();

    expect(screen.getByRole("button", { name: "Clear recurrence" })).toBeInTheDocument();
  });

  it("clears the rule and keeps the day", () => {
    const { onPickDay, onPickRecurrence } = renderPopover(RECURRING);
    open();

    fireEvent.click(screen.getByRole("button", { name: "Clear recurrence" }));

    // The distinction this whole ticket turns on: the rule goes, the date
    // stays. `No Date` — the only previous way out of a recurrence — would
    // have called onPickDay(null) and taken the date with it.
    expect(onPickDay).toHaveBeenCalledWith("2026-09-10");
    expect(onPickRecurrence).not.toHaveBeenCalled();
  });

  it("keeps a Clear item inside the menu too, and marks the active rule", () => {
    renderPopover(RECURRING);
    open();
    // Radix opens its menu on pointerdown, not click — the same reason the
    // Android rig never uses a synthetic element.click() on one.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Every day" }));

    const menu = screen.getByTestId("repeat-menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent ?? "");
    // Removal has two doors in Todoist — the standalone button and this.
    expect(items.at(-1)).toBe("Clear");
    // The active rule carries a check the plain menu's items do not.
    const daily = within(menu).getByText("Every day");
    expect(daily.closest('[role="menuitem"]')?.querySelector("svg")).not.toBeNull();
  });

  it("offers no Clear anywhere when the Task does not recur", () => {
    renderPopover({ dateDay: "2026-09-10", dateString: null });
    open();

    expect(screen.queryByRole("button", { name: "Clear recurrence" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
    const items = within(screen.getByTestId("repeat-menu"))
      .getAllByRole("menuitem")
      .map((i) => i.textContent ?? "");
    expect(items).not.toContain("Clear");
  });
});

describe("TaskSchedulePopover", () => {
  // Every assertion in this suite was measured against Todoist's anchored
  // popover at desktop width, so it runs at desktop width.
  beforeEach(() => {
    stubLayout(true);
  });

  // Issue #436's own comment correction (2026-09-21) replaced "always
  // five, nothing elided" with a table keyed on the CURRENT value alone —
  // Today/Tomorrow/No Date are the only ones ever elided, and an elided
  // Today/Tomorrow is replaced (not just dropped) by "Later this week".
  // This whole describe block was rewritten against that table rather
  // than patched, since the old "drop whatever quick option equals
  // dateDay" rule it replaces touched every option, not just these three.
  describe("quick options (issue #436's elision table)", () => {
    // Scoped to `quick-options` (task-schedule-popover.tsx's own
    // `data-testid`), not the whole scheduler: the calendar's own day
    // buttons carry an aria-label starting with "Today" for today's own
    // cell (react-day-picker's convention), and a Task-opened prefill
    // (issue #436) can also render the input's own "Clear" (×) button
    // before the quick options in DOM order — both would otherwise
    // collide with the assertions below.
    function names() {
      return (
        within(screen.getByTestId("quick-options"))
          .getAllByRole("button")
          // Read off `aria-label` rather than `textContent` — the label and
          // hint sit in two sibling `<span>`s with no literal whitespace
          // between them in the DOM (this file's own QuickOption comment),
          // so e.g. "Next week"'s own `textContent` reads "Next weekMon 14
          // Sep"; `aria-label` is set explicitly with a real space.
          .map((button) => button.getAttribute("aria-label") ?? "")
      );
    }

    it("'any other day': all five, in Todoist's own order, with the exact captured hints", () => {
      // 2026-09-20 is neither NOW's today (10 Sep) nor tomorrow (11 Sep).
      renderPopover({ dateDay: "2026-09-20" });
      open();

      expect(screen.getByRole("button", { name: "Today Thu" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toBeInTheDocument();
      // Always a Saturday, so the hint is always just its weekday.
      expect(screen.getByRole("button", { name: "This weekend Sat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();

      const all = names();
      expect(all.findIndex((n) => n.startsWith("Today"))).toBeLessThan(
        all.findIndex((n) => n.startsWith("Tomorrow")),
      );
      expect(all.findIndex((n) => n.startsWith("Tomorrow"))).toBeLessThan(
        all.findIndex((n) => n.startsWith("This weekend")),
      );
      expect(all.findIndex((n) => n.startsWith("This weekend"))).toBeLessThan(
        all.findIndex((n) => n.startsWith("Next week ")),
      );
      expect(all.findIndex((n) => n.startsWith("Next week "))).toBeLessThan(all.indexOf("No Date"));
    });

    it("'No date' (no dateDay, not alwaysDated): four options, No Date dropped — nothing else changes", () => {
      renderPopover({ dateDay: null });
      open();

      expect(screen.getByRole("button", { name: "Today Thu" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "This weekend Sat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "No Date" })).not.toBeInTheDocument();
      expect(names()).toHaveLength(4);
    });

    it("Reschedule's alwaysDated exception: no dateDay, but No Date stays — five options, the 'any other day' shape", () => {
      renderPopover({ dateDay: null, alwaysDated: true });
      open();

      expect(screen.getByRole("button", { name: "Today Thu" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "This weekend Sat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();
      expect(names()).toHaveLength(5);
    });

    it("current value = Today: Tomorrow, Later this week, This weekend, Next week, No Date — in that order", () => {
      renderPopover({ dateDay: "2026-09-10" }); // NOW's own today
      open();

      // Scoped to `quick-options` — the calendar's own today cell carries
      // an aria-label that ALSO starts with "Today" (react-day-picker's
      // own convention), which this regex would otherwise match too.
      expect(
        within(screen.getByTestId("quick-options")).queryByRole("button", { name: /^Today/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toBeInTheDocument();
      // NOW is a Thursday: `laterThisWeekDay`'s own two-days-out reading
      // (Sat) lands on the weekend, so it clamps to the last weekday
      // before it — Friday, the same date Tomorrow already names. A
      // disclosed edge case (`laterThisWeekDay`'s own header comment,
      // task-schedule-popover.tsx), not a defect this test is hiding.
      expect(screen.getByRole("button", { name: "Later this week Fri" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "This weekend Sat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();

      const all = names();
      expect(all.slice(0, 2)).toEqual(["Tomorrow Fri", "Later this week Fri"]);
    });

    it("current value = Tomorrow: Today, Later this week, This weekend, Next week, No Date — in that order", () => {
      renderPopover({ dateDay: "2026-09-11" }); // NOW's own tomorrow
      open();

      expect(screen.getByRole("button", { name: "Today Thu" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Tomorrow/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Later this week Fri" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "This weekend Sat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();

      const all = names();
      expect(all.slice(0, 2)).toEqual(["Today Thu", "Later this week Fri"]);
    });

    it("'Later this week' resolves the measured Mon -> Wed example cleanly when the clamp doesn't apply", () => {
      const { onPickDay } = renderPopover({ dateDay: "2026-09-07", now: MONDAY_NOW });
      open();

      const laterThisWeek = screen.getByRole("button", { name: "Later this week Wed" });
      expect(laterThisWeek).toBeInTheDocument();

      fireEvent.click(laterThisWeek);

      expect(onPickDay).toHaveBeenCalledWith("2026-09-09");
    });

    it("Next week is never elided, even when the current value is Next week's own day (only Today/Tomorrow/No Date ever are)", () => {
      renderPopover({ dateDay: "2026-09-14" }); // Next week's own day from NOW
      open();

      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Today Thu" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "This weekend Sat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();
    });

    it("This weekend is never elided either, even when the current value is This weekend's own day", () => {
      renderPopover({ dateDay: "2026-09-12" }); // This weekend's own day from NOW
      open();

      expect(screen.getByRole("button", { name: "This weekend Sat" })).toBeInTheDocument();
    });

    it("no longer dedupes a Tomorrow/Next week collision — both show, unlike this component's pre-#436 behaviour", () => {
      // Sun 13 Sep 2026: tomorrow (Mon 14) and "next Monday" land on the
      // identical day. The old rule dropped one as a duplicate; issue
      // #436's own elision table has no such rule, only the three named
      // ones above, so both now show.
      renderPopover({ now: new Date(2026, 8, 13, 12, 0) });
      open();

      expect(screen.getByRole("button", { name: "Tomorrow Mon" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
    });

    it("'Today' commits today's local day key and closes", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: "Today Thu" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-10");
      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });

    it("'Tomorrow' commits the next local day key", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: "Tomorrow Fri" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-11");
    });

    it("'Next week' commits the coming Monday", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: "Next week Mon 14 Sep" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-14");
    });

    it("'This weekend' commits the next Saturday strictly after now", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: "This weekend Sat" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-12");
    });

    it("'This weekend' skips today and lands a full week out when now is itself a Saturday", () => {
      // The row's own Sat-12-Sep data point: This weekend resolves to
      // Sat 19 Sep, not today, even though today is a Saturday — the hint
      // itself no longer encodes which Saturday (always just "Sat"), so
      // this is provable only via the committed day.
      const SATURDAY_NOW = new Date(2026, 8, 12, 12, 0);
      const { onPickDay } = renderPopover({ now: SATURDAY_NOW });
      open();

      fireEvent.click(screen.getByRole("button", { name: "This weekend Sat" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-19");
    });

    it("offers no 'No Date' option until a date is already set", () => {
      renderPopover({ dateDay: null });
      open();

      expect(screen.queryByRole("button", { name: "No Date" })).not.toBeInTheDocument();
    });

    it("offers 'No Date' once a date is set, and it clears the date", () => {
      const { onPickDay } = renderPopover({ dateDay: "2026-09-05" });
      open();

      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onPickDay).toHaveBeenCalledWith(null);
    });
  });

  // Issue #436's own frame — sizes, dividers, and the `--td-*` tokens each
  // themed element reads. jsdom applies no real stylesheet (`index.css` is
  // stubbed to an empty string under vitest — `check-css-cascade.mjs`'s
  // own header comment), so these assert the SOURCE each element carries
  // — the literal `var(--td-schedule-*)` string in a `style` prop, or the
  // literal class naming a token — rather than a resolved colour; that a
  // token with that exact name is DEFINED, correctly, for both themes is
  // `check-css-cascade.mjs`'s own job (wired into `build:web`), verified
  // separately by reading `index.css` directly.
  describe("frame (issue #436)", () => {
    it("reads the fixed 250×555 card size off its own CSS tokens, not a literal", () => {
      renderPopover();
      open();

      const view = screen.getByTestId("scheduler-view");
      expect(view.style.width).toBe("var(--td-popover-width)");
      expect(view.style.minHeight).toBe("var(--td-popover-min-height)");
      expect(view.style.background).toBe("var(--td-popover-background)");
      expect(view.style.boxShadow).toBe("var(--td-popover-shadow)");
    });

    it("renders exactly three dividers — after the input, after the quick options, and after the calendar", () => {
      renderPopover();
      open();

      const dividers = within(screen.getByTestId("scheduler-view")).getAllByTestId(
        "schedule-divider",
      );
      expect(dividers).toHaveLength(3);
      for (const divider of dividers) {
        // A Tailwind arbitrary-value class (`bg-[color:var(...)]`), not an
        // inline `style` — jsdom applies no real stylesheet, so the class
        // STRING is what proves the token is wired, the same convention
        // this file's own pre-existing calendar tests already use.
        expect(divider.className).toContain("bg-[color:var(--td-popover-divider)]");
      }
    });

    it("the input carries its own text/placeholder tokens", () => {
      renderPopover();
      open();

      const input = screen.getByPlaceholderText("Type a date");
      expect(input.style.color).toBe("var(--td-schedule-input-text)");
      expect(input.className).toContain(
        "placeholder:text-[color:var(--td-schedule-input-placeholder)]",
      );
    });

    it("each quick option's icon, label, and hint read their own tokens — Today's own as the representative case", () => {
      renderPopover({ dateDay: "2026-09-20" });
      open();

      const today = screen.getByRole("button", { name: "Today Thu" });
      const icon = today.querySelector("svg");
      expect(icon).toHaveStyle({ color: "var(--td-schedule-today)" });
      const label = within(today).getByText("Today");
      expect(label).toHaveStyle({ color: "var(--td-schedule-option-label)" });
      const hint = within(today).getByText("Thu");
      expect(hint).toHaveStyle({ color: "var(--td-schedule-option-hint)" });
    });

    it("gives Tomorrow, This weekend, Next week, and No Date each their own distinct icon token", () => {
      renderPopover({ dateDay: "2026-09-20" });
      open();

      const iconVarOf = (name: string) =>
        screen.getByRole("button", { name }).querySelector("svg")?.style.color;
      expect(iconVarOf("Tomorrow Fri")).toBe("var(--td-schedule-tomorrow)");
      expect(iconVarOf("This weekend Sat")).toBe("var(--td-schedule-this-weekend)");
      expect(iconVarOf("Next week Mon 14 Sep")).toBe("var(--td-schedule-next-week)");
      expect(iconVarOf("No Date")).toBe("var(--td-schedule-no-date)");
    });

    it("gives 'Later this week' its own token, family-linked to Tomorrow's rather than a fourth literal", () => {
      renderPopover({ dateDay: "2026-09-10" }); // elides Today, adds Later this week
      open();

      const icon = screen.getByRole("button", { name: "Later this week Fri" }).querySelector("svg");
      expect(icon).toHaveStyle({ color: "var(--td-schedule-later-this-week)" });
    });

    it("Time and Repeat carry the measured field border/text tokens, sized 226×32", () => {
      renderPopover({ dateDay: "2026-09-05" });
      open();

      for (const name of ["Time", "Repeat"]) {
        const button = screen.getByRole("button", { name });
        expect(button.style.borderColor).toBe("var(--td-schedule-field-border)");
        expect(button.style.color).toBe("var(--td-schedule-field-text)");
        expect(button.className).toContain("w-[226px]");
        expect(button.className).toContain("h-8");
      }
    });
  });

  describe("calendar — the six defects measured live 2026-09-15", () => {
    it("starts the week on Monday", () => {
      renderPopover();
      open();

      // `<th>` role resolution inside a `role="grid"` table is finicky in
      // jsdom's accessibility tree — reading the header cells directly
      // sidesteps that rather than fighting it.
      const headers = Array.from(document.querySelectorAll("th"));
      expect(headers.map((h) => h.textContent)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    });

    it("clicking a day commits that day and closes, with no separate Confirm step", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: /September 20th, 2026/ }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-20");
      expect(screen.queryByRole("button", { name: /^Confirm/ })).not.toBeInTheDocument();
    });

    it("today carries no aria-current (deliberate)", () => {
      renderPopover();
      open();

      const today = screen.getByRole("button", { name: /September 10th, 2026/ });
      expect(today).not.toHaveAttribute("aria-current");
      // The `<td>` cell DayPicker itself flags as today, independent of
      // this file's own styling override. Read through the component's
      // own injected `now` (NOW = Thu 10 Sep), not react-day-picker's
      // default reading of the real system clock — `today={now}` on the
      // `<Calendar>` below is what makes this assertion mean anything on
      // any day other than the one this suite happens to run on.
      expect(document.querySelector('[data-day="2026-09-10"]')).toHaveAttribute(
        "data-today",
        "true",
      );
    });

    it("today's colour utility carries `!important` so it wins over the weekend utility on a weekday's cell too", () => {
      renderPopover();
      open();

      // Thu 10 Sep 2026 is a weekday, so this cell should carry ONLY the
      // today styling, not the weekend one.
      const cell = document.querySelector('[data-day="2026-09-10"]');
      expect(cell?.className).toContain("text-[color:var(--td-calendar-today)]!");
      expect(cell?.className).not.toContain("text-muted-foreground");
    });

    it("today's colour utility still carries `!important` when today is itself a weekend day", () => {
      // The measured defect: Sat 12 Sep 2026 driven as "now" through the
      // SAME injected clock every other assertion in this file uses (not
      // the real system clock, which is not this date) — react-day-picker
      // must derive its own `data-today` from that same injected value via
      // this component's `today={now}` prop, or this test would silently
      // pass on the capture day and go stale everywhere else, exactly the
      // trap this row's own earlier test fell into.
      const SATURDAY_NOW = new Date(2026, 8, 12, 12, 0); // Sat 12 Sep 2026
      renderPopover({ now: SATURDAY_NOW });
      open();

      const cell = document.querySelector('[data-day="2026-09-12"]');
      expect(cell).toHaveAttribute("data-today", "true");
      expect(cell?.className).toContain("text-[color:var(--td-calendar-today)]!");
      expect(cell?.className).toContain("text-muted-foreground");
    });

    it("the selected day is a filled circle — the cell carries data-selected", () => {
      renderPopover({ dateDay: "2026-09-05" });
      open();

      const cell = document.querySelector('[data-day="2026-09-05"]');
      expect(cell).toHaveAttribute("data-selected", "true");
      expect(cell?.className).toContain("bg-[color:var(--td-calendar-selected)]");
    });

    it("weekends dim independently of today/selected", () => {
      renderPopover();
      open();

      // 2026-09-12 is a Saturday.
      const cell = document.querySelector('[data-day="2026-09-12"]');
      expect(cell?.className).toContain("text-muted-foreground");
    });

    it("a day carrying a Task gets the busy-dot modifier", () => {
      renderPopover({ datesWithTasks: new Map([["2026-09-14", 2]]) });
      open();

      const busyCell = document.querySelector('[data-day="2026-09-14"]');
      const quietCell = document.querySelector('[data-day="2026-09-15"]');
      expect(busyCell?.className).toContain("before:content-['']");
      expect(quietCell?.className).not.toContain("before:content-['']");
    });

    it("a day that is both today and selected gets the selected (white-on-coral) treatment, not today-red (defect 1)", () => {
      // NOW = Thu 10 Sep 2026 (module-level constant above) — seeding
      // `dateDay` with that same day makes the 10th both `data-today` and
      // `data-selected` at once, the exact collision defect 1 measured
      // live: text rgb(226,106,96) on fill rgb(222,76,74), contrast ratio
      // 1.23:1.
      renderPopover({ dateDay: "2026-09-10" });
      open();

      const cell = document.querySelector('[data-day="2026-09-10"]');
      expect(cell).toHaveAttribute("data-today", "true");
      expect(cell).toHaveAttribute("data-selected", "true");
      // The contract, not the paint: `today`'s colour utility is now
      // scoped with `:not([data-selected=true])`, so on a cell that also
      // carries `data-selected="true"` this rule cannot match at all —
      // jsdom can confirm the selector text is exactly this scoped form
      // (not the old unconditional one), but computing which colour
      // actually paints needs a real cascade, which jsdom never runs.
      expect(cell?.className).toContain(
        "[&:not([data-selected=true])>button]:text-[color:var(--td-calendar-today)]!",
      );
      // `selected`'s own white/fill classes are present and — because the
      // scoped `today` rule above no longer contests them on this cell —
      // are the only ones left standing. The real check that they
      // actually render legibly is the live-browser pass this ticket asks
      // for, not this suite.
      expect(cell?.className).toContain("bg-[color:var(--td-calendar-selected)]");
      expect(cell?.className).toContain("text-white");
    });

    it("the day button carries Todoist's measured hover/focus-visible pill classes, not `ghost`'s translucent hover or an absent focus ring (defects 2/3)", () => {
      renderPopover();
      open();

      const dayButton = screen.getByRole("button", { name: /September 20th, 2026/ });
      // Defect 3: the opaque measured hover pill, via the shared
      // `--td-calendar-cell-hover` token — not `ghost`'s own translucent
      // `hover:bg-muted`.
      expect(dayButton.className).toContain("hover:bg-[color:var(--td-calendar-cell-hover)]");
      // `ghost`'s own dark-mode hover (`dark:hover:bg-muted/50`,
      // button.tsx) outranks a bare `hover:` override by CSS specificity
      // alone (`.dark .cls:hover` beats `.cls:hover` regardless of
      // stylesheet order) — dark being the only theme Todoist was ever
      // measured in, this needs its own `dark:` twin of the token, not
      // just the plain one.
      expect(dayButton.className).toContain("dark:hover:bg-[color:var(--td-calendar-cell-hover)]");
      // A plain substring check would false-positive on the token
      // literal above (it contains "hover:bg-" as a substring of its own
      // `dark:hover:bg-[...]` form) — split into tokens so only the exact
      // `hover:bg-muted` / `dark:hover:bg-muted/50` utilities are
      // asserted absent.
      const classTokens = dayButton.className.split(" ");
      expect(classTokens).not.toContain("hover:bg-muted");
      expect(classTokens).not.toContain("dark:hover:bg-muted/50");
      // Defect 2: the measured focus-visible pill (the same token at
      // 30.6% opacity — `rgba(77, 77, 77, 0.306)`), with `ghost`'s own
      // ring/border neutralised so nothing competes with it.
      expect(dayButton.className).toContain(
        "focus-visible:bg-[color:var(--td-calendar-cell-hover)]/[30.6%]",
      );
      expect(dayButton.className).toContain("focus-visible:ring-0");
      expect(dayButton.className).toContain("focus-visible:border-transparent");
      // NOTE ON WHAT THIS DOES NOT PROVE: jsdom resolves neither `:hover`
      // nor `:focus-visible` — this only shows the classes carrying the
      // measured values are present on the element, not that hovering or
      // focusing it actually paints them. That check is the live-browser
      // pass.
    });

    it("outside-month days carry no dimming classes of their own (defect 4)", () => {
      renderPopover();
      open();

      // Sep 2026 starts on a Tuesday and the week starts Monday, so the
      // grid's first row leads with Mon 31 Aug 2026 — an outside day, and
      // itself a weekday (not a weekend), which isolates the `outside`
      // dimming this test is about from `weekend`'s own (correct,
      // untouched) grey.
      const cell = document.querySelector('[data-day="2026-08-31"]');
      expect(cell).toHaveAttribute("data-outside", "true");
      // The base `Calendar` primitive's own `outside` default
      // (`text-muted-foreground opacity-50`, calendar.tsx) is blanked at
      // this call site — Todoist showed next-month days painted exactly
      // like same-weekday current-month ones, no distinguishing class at
      // all.
      expect(cell?.className).not.toContain("opacity-50");
      expect(cell?.className).not.toContain("text-muted-foreground");
    });

    it("the day button is sized and radiused toward Todoist's measured cell, not the old square 24px circle (defect 5)", () => {
      renderPopover();
      open();

      const dayButton = screen.getByRole("button", { name: /September 20th, 2026/ });
      // Todoist's own cell is ≈30.4×28px; `h-7` (28px) / `w-[30px]` moves
      // toward that.
      expect(dayButton.className).toContain("h-7");
      expect(dayButton.className).toContain("w-[30px]");
      // The measured 12px selected-pill radius, pinned directly rather
      // than left to `rounded-full`'s side effect on a now non-square box
      // (see this key's own comment in task-schedule-popover.tsx for why
      // `rounded-full` would silently stop being 12px once the box
      // stopped being square).
      expect(dayButton.className).toContain("rounded-[12px]");
      expect(dayButton.className).not.toContain("rounded-full");
    });

    it("the month caption reads Todoist's short form, 'Sep 2026', not the locale's full month name (defect 6)", () => {
      renderPopover();
      open();

      expect(screen.getByText("Sep 2026")).toBeInTheDocument();
      expect(screen.queryByText("September 2026")).not.toBeInTheDocument();
    });
  });

  describe("Type a date", () => {
    it("resolves a plain date and shows a preview above the quick options", () => {
      renderPopover();
      open();

      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "21 sep" },
      });

      const preview = screen.getByTestId("scheduler-date-preview");
      expect(preview).toHaveTextContent("Mon 21 Sep");
    });

    it("clicking the preview commits the resolved day and closes", () => {
      const { onPickDay } = renderPopover();
      open();
      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "21 sep" },
      });

      fireEvent.click(screen.getByTestId("scheduler-date-preview"));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-21");
      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });

    it("resolves a recurrence phrase — the exact 'every monday' -> Mon 14 Sep -> Forever example the reference capture measured", () => {
      renderPopover();
      open();

      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "every monday" },
      });

      const preview = screen.getByTestId("scheduler-date-preview");
      expect(preview).toHaveTextContent("Mon 14 Sep");
      expect(preview).toHaveTextContent("Forever");
      expect(preview).toHaveTextContent("No tasks");
    });

    it("shows the real Task count on the resolved date when one is known", () => {
      renderPopover({ datesWithTasks: new Map([["2026-09-14", 3]]) });
      open();

      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "every monday" },
      });

      expect(screen.getByTestId("scheduler-date-preview")).toHaveTextContent("3 tasks");
    });

    it("clicking a recurrence preview commits via onPickRecurrence, not onPickDay", () => {
      const { onPickDay, onPickRecurrence } = renderPopover();
      open();
      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "every monday" },
      });

      fireEvent.click(screen.getByTestId("scheduler-date-preview"));

      expect(onPickRecurrence).toHaveBeenCalledWith("every monday", "2026-09-14");
      expect(onPickDay).not.toHaveBeenCalled();
    });

    it("pressing Enter commits the preview the same way clicking it does", () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const input = screen.getByPlaceholderText("Type a date");
      fireEvent.change(input, { target: { value: "every monday" } });

      fireEvent.keyDown(input, { key: "Enter" });

      expect(onPickRecurrence).toHaveBeenCalledWith("every monday", "2026-09-14");
    });

    it("shows no preview for unresolvable text", () => {
      renderPopover();
      open();

      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "xyzzy" },
      });

      expect(screen.queryByTestId("scheduler-date-preview")).not.toBeInTheDocument();
    });

    it("seeds the input with an existing Recurrence on open — the one editable surface (issue #227)", () => {
      renderPopover({ dateString: "every friday" });
      open();

      expect(screen.getByPlaceholderText("Type a date")).toHaveValue("every friday");
    });

    it("the Clear (X) button empties the typed text without committing anything", () => {
      const { onPickDay, onPickRecurrence } = renderPopover();
      open();
      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "21 sep" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Clear" }));

      expect(screen.getByPlaceholderText("Type a date")).toHaveValue("");
      expect(screen.queryByTestId("scheduler-date-preview")).not.toBeInTheDocument();
      expect(onPickDay).not.toHaveBeenCalled();
      expect(onPickRecurrence).not.toHaveBeenCalled();
    });
  });

  // Issue #436's own "Opened from a Task" state: the input pre-fills with
  // the Task's own date text, the whole text selected, and — unlike a
  // Recurrence seed — no preview row underneath it until the reader
  // actually edits (Todoist's own screenshot shows the quick options
  // directly below the selected input, nothing in between).
  describe("Task-opened prefill (issue #436)", () => {
    it("pre-fills 'd MMM HH:MM' for a dated, timed Task, with the whole text selected", () => {
      renderPopover({ dateDay: "2026-09-19", dateTime: "21:00" });
      open();

      const input = screen.getByPlaceholderText("Type a date") as HTMLInputElement;
      expect(input).toHaveValue("19 Sep 21:00");
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
      // Todoist's own screenshot: no preview row under a freshly-opened,
      // untouched prefill — unlike an existing Recurrence's own seed
      // (`seeds the input with an existing Recurrence on open`, above),
      // which has always shown one immediately.
      expect(screen.queryByTestId("scheduler-date-preview")).not.toBeInTheDocument();
    });

    it("pre-fills 'd MMM' with no time for a dated, untimed Task", () => {
      renderPopover({ dateDay: "2026-09-19", dateTime: null });
      open();

      const input = screen.getByPlaceholderText("Type a date") as HTMLInputElement;
      expect(input).toHaveValue("19 Sep");
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
    });

    it("stays empty, with the 'Type a date' placeholder, for an undated Task", () => {
      renderPopover({ dateDay: null, dateTime: null });
      open();

      expect(screen.getByPlaceholderText("Type a date")).toHaveValue("");
    });

    it("a real edit to the prefilled text starts resolving a preview again", () => {
      renderPopover({ dateDay: "2026-09-19", dateTime: null });
      open();

      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "21 sep" },
      });

      expect(screen.getByTestId("scheduler-date-preview")).toBeInTheDocument();
    });

    it("retyping the identical prefilled date still counts as an edit — the preview resolves", () => {
      renderPopover({ dateDay: "2026-09-19", dateTime: null });
      open();

      // Lower-cased, matching every other typed-date test in this file
      // (e.g. "resolves a plain date..." above) — the point here is that
      // "the reader typed the same date back" still counts as an edit,
      // not a claim about the parser's own case sensitivity, which this
      // file's own passing tests already establish is lower-case.
      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "19 sep" },
      });

      expect(screen.getByTestId("scheduler-date-preview")).toBeInTheDocument();
    });
  });

  describe("Time dialog (replaces issue #249's inline 'Add a time' toggle)", () => {
    function openTimeDialog() {
      fireEvent.click(screen.getByRole("button", { name: "Time" }));
      return screen.getByRole("dialog", { name: "Select start and end time" });
    }

    it("renders no Time button until a date is set", () => {
      renderPopover({ dateDay: null });
      open();

      expect(screen.queryByRole("button", { name: "Time" })).not.toBeInTheDocument();
    });

    // Issue #436: "Time shows the value ('21:00') with a × to clear."
    // `aria-label="Time"` is pinned regardless (this component's own
    // comment above the button), so every OTHER test in this describe
    // block that finds it by `{ name: "Time" }` is unaffected by a value
    // being set — these two are the only ones that also look at what's
    // actually rendered inside it.
    it("shows the Task's own time value on the button, and a Clear-time affordance beside it", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: "21:00" });
      open();

      const timeButton = screen.getByRole("button", { name: "Time" });
      expect(timeButton).toHaveTextContent("21:00");
      expect(timeButton).not.toHaveTextContent(/^Time$/);

      fireEvent.click(screen.getByRole("button", { name: "Clear time" }));

      expect(onSetTime).toHaveBeenCalledWith(null);
      // Clearing is a one-click affordance, not a shortcut into the
      // dialog it sits beside — `event.stopPropagation()`'s own comment.
      expect(
        screen.queryByRole("dialog", { name: "Select start and end time" }),
      ).not.toBeInTheDocument();
    });

    it("shows plain 'Time' with no Clear-time affordance when no time is set", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();

      expect(screen.getByRole("button", { name: "Time" })).toHaveTextContent(/^Time$/);
      expect(screen.queryByRole("button", { name: "Clear time" })).not.toBeInTheDocument();
    });

    // Issue #435: Reschedule has no single `dateDay` of its own (a bulk
    // move across Tasks with different existing dates has no single
    // "current" one to seed the picker with), but every Overdue Task it
    // applies a bulk Time to already carries a real day of its own —
    // `alwaysDated` is that action's own escape hatch from the gate just
    // above.
    it("shows the Time button even with no date, when alwaysDated is set (issue #435's Reschedule)", () => {
      renderPopover({ dateDay: null, alwaysDated: true });
      open();

      expect(screen.getByRole("button", { name: "Time" })).toBeInTheDocument();
    });

    // The identical escape hatch also keeps "No Date" itself reachable —
    // it's gated the same way, for the same reason.
    it("also shows the No Date quick option with no date, when alwaysDated is set", () => {
      renderPopover({ dateDay: null, alwaysDated: true });
      open();

      expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();
    });

    it("the inline time field is gone — no bare time input renders in the scheduler itself", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: "14:30" });
      open();

      expect(screen.queryByText("Add a time")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Start time")).not.toBeInTheDocument();
      // `{ selector: "input" }`: issue #436 gives the Time BUTTON its own
      // `aria-label="Time"` (so it keeps reading as "Time" even once its
      // visible text becomes a value like "14:30" — that button's own
      // comment), and `getByLabelText` matches any element's `aria-label`
      // by default, not just form fields — without the selector this
      // would now find that legitimate button instead of proving no bare
      // `<input>` exists, which is what this test is actually about.
      expect(screen.queryByLabelText("Time", { selector: "input" })).not.toBeInTheDocument();
    });

    it("the Time button opens a dialog with Todoist's own recorded title and fields", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();

      const dialog = openTimeDialog();

      expect(dialog).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Add a time")).not.toBeChecked();
      expect(within(dialog).queryByLabelText("Start time")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      // Opening it doesn't close the scheduler underneath (this ticket's
      // own Radix trap, issue #255's shape) — item 5 of this ticket's brief.
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    it("checking 'Add a time' inside the dialog reveals the Start time field, seeded with the existing value", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: "14:30" });
      open();
      const dialog = openTimeDialog();

      expect(within(dialog).getByLabelText("Add a time")).toBeChecked();
      expect(within(dialog).getByLabelText("Start time")).toHaveValue("14:30");
    });

    // Issue #326: Save closes the *whole* scheduler, not just this dialog —
    // unlike Cancel (the test below this one), which returns to it. This
    // used to look identical to Cancel only because nothing here told the
    // two apart yet; `handleTimeSave` (task-schedule-popover.tsx) now makes
    // the difference explicit with its own `setOpen(false)`. jsdom can
    // verify that explicit call reliably (it's an ordinary synchronous
    // state update, not the portalled dismiss-ordering race the rest of
    // this ticket is about) — see the Cancel test below for what jsdom
    // still can't see.
    it("Save commits the drafted time through the same onSetTime callback the inline field used, and closes the whole scheduler (issue #326)", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();
      const dialog = openTimeDialog();

      fireEvent.click(within(dialog).getByLabelText("Add a time"));
      fireEvent.change(within(dialog).getByLabelText("Start time"), {
        target: { value: "16:00" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(onSetTime).toHaveBeenCalledWith("16:00");
      expect(
        screen.queryByRole("dialog", { name: "Select start and end time" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });

    it("Save with 'Add a time' unchecked commits null — the dialog's own mirror of the inline field's existing clear path", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: "09:00" });
      open();
      const dialog = openTimeDialog();

      fireEvent.click(within(dialog).getByLabelText("Add a time"));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(onSetTime).toHaveBeenCalledWith(null);
    });

    // Issue #326's own bug (Cancel closing the whole scheduler, though
    // documented as returning to it) was invisible to this exact test
    // before the fix, and this assertion alone still can't prove the real
    // fix holds: `classifyOutsideInteraction` (task-schedule-popover.tsx,
    // above `TaskSchedulePopoverProps`) only has anything to classify once
    // Radix actually dispatches `onPointerDownOutside`/`onInteractOutside`,
    // and it does that from a deferred, `document`-level "click" listener
    // registered after a real "pointerdown". `fireEvent.click(...)` below
    // fires a bare "click" with no preceding "pointerdown" at all, so that
    // dispatch — and the flushSync-ordering race issue #326 is actually
    // about — never runs in jsdom, fixed or not (see `isOwnedPortalTarget`'s
    // own describe block, below every `describe` in this file, for the part
    // of the fix that genuinely is unit-testable). What this test *can*
    // verify honestly is the wiring — Cancel never reaches `onSetTime`, and
    // `scheduler-view` is still there right after. That the scheduler stays
    // open through the real dismiss race live in a browser is captured
    // evidence, not something this suite asserts.
    it("Cancel discards the draft: onSetTime is never called, and the Task's own time is unchanged next time the dialog opens", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: "09:00" });
      open();
      const dialog = openTimeDialog();

      fireEvent.change(within(dialog).getByLabelText("Start time"), {
        target: { value: "23:00" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(onSetTime).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("dialog", { name: "Select start and end time" }),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();

      // Re-opening re-seeds from the Task's real, unchanged dateTime —
      // the abandoned "23:00" draft is gone.
      const reopened = openTimeDialog();
      expect(within(reopened).getByLabelText("Start time")).toHaveValue("09:00");
    });

    it("never calls onPickDay, and the popover stays fully interactive underneath while the dialog is open", () => {
      const { onPickDay } = renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();
      openTimeDialog();

      expect(onPickDay).not.toHaveBeenCalled();
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Type a date")).toBeInTheDocument();
    });

    it("Escape closes both the Time dialog and the scheduler, without committing a time", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: "09:00" });
      open();
      const dialog = openTimeDialog();

      fireEvent.change(within(dialog).getByLabelText("Start time"), {
        target: { value: "23:00" },
      });
      fireEvent.keyDown(dialog, { key: "Escape" });

      expect(onSetTime).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("dialog", { name: "Select start and end time" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });
  });

  describe("Repeat menu (issue #227)", () => {
    // Radix's `DropdownMenu.Trigger` opens on `pointerdown`, not `click`
    // (task-row.test.tsx's own identical "More actions" precedent) — a
    // plain `fireEvent.click` alone never opens it under jsdom.
    function openRepeatMenu() {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
      return screen.getByTestId("repeat-menu");
    }

    it("renders the six items, in Todoist's own order and wording, for the fixed injected now (undated Task)", () => {
      renderPopover();
      open();

      const menu = openRepeatMenu();
      const items = within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);

      expect(items).toEqual([
        "Every day",
        "Every week on Thursday",
        "Every weekday (Mon - Fri)",
        "Every month on the 10th",
        "Every year on September 10th",
        "Custom…",
      ]);
    });

    it("computes the menu off the Task's current date, not `now`, when the Task already has one", () => {
      // dateDay 2026-09-14 is a Monday. "every month"/"every year" are
      // due-anchored (recurrence.ts's own header comment) so their labels
      // follow dateDay's own day-of-month/month-and-day, and the weekly
      // option names dateDay's own weekday.
      renderPopover({ dateDay: "2026-09-14" });
      open();

      const menu = openRepeatMenu();
      const items = within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);

      expect(items).toEqual([
        "Every day",
        "Every week on Monday",
        "Every weekday (Mon - Fri)",
        "Every month on the 14th",
        "Every year on September 14th",
        "Custom…",
      ]);
    });

    it("'Every day' commits 'every day' through onPickRecurrence and closes", () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every day" }));

      expect(onPickRecurrence).toHaveBeenCalledWith("every day", "2026-09-10");
      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });

    it("'Every week on Thursday' commits the named weekday, which stays on Thursdays however late the task is completed", () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every week on Thursday" }));

      expect(onPickRecurrence).toHaveBeenCalledWith("every thursday", "2026-09-10");
    });

    it("'Every weekday (Mon - Fri)' commits 'every workday' — this repo's own accepted spelling for the identical Mon-Fri pattern", () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every weekday (Mon - Fri)" }));

      expect(onPickRecurrence).toHaveBeenCalledWith("every workday", "2026-09-10");
    });

    it("'Every month on the 10th' commits the bare 'every month' phrase", () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every month on the 10th" }));

      expect(onPickRecurrence).toHaveBeenCalledWith("every month", "2026-09-10");
    });

    it("'Every year on September 10th' commits the bare 'every year' phrase", () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every year on September 10th" }));

      expect(onPickRecurrence).toHaveBeenCalledWith("every year", "2026-09-10");
    });

    /**
     * Issue #292 replaced this item's behaviour outright. Until it landed,
     * "Custom…" closed the menu and focused the "Type a date" input —
     * #227's own disclosed scope cut, which read on screen as a dead menu
     * item. The two tests here previously asserted that focus hand-off;
     * they now assert the dialog, because the old behaviour is what the
     * ticket exists to remove, not a contract it broke by accident.
     */
    it("'Custom…' opens the Custom repeat dialog and commits nothing on its own", async () => {
      const { onPickRecurrence, onPickDay } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));

      // The dialog opens on the menu's own `onCloseAutoFocus` (issue
      // #255's precedent, reused) — real, not synthetic in jsdom, so it
      // lands asynchronously once Radix has torn the menu down.
      await vi.waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Custom repeat" })).toBeInTheDocument();
      });
      expect(onPickRecurrence).not.toHaveBeenCalled();
      expect(onPickDay).not.toHaveBeenCalled();
      // The scheduler stays open beneath it. This is the assertion that
      // would have caught the Radix trap the two-step hand-off exists for:
      // a dialog opened straight from `onSelect` opens and is immediately
      // dismissed along with the popover, which looks identical to the
      // dead item #292 is removing.
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    it("'Custom…' leaves whatever text is already typed in place — opening the dialog never clears the field", async () => {
      // The Repeat control itself only shows while there's no active
      // recurrence preview (the test below this one), so the case this
      // is actually guarding is a Task with a plain date already typed —
      // "Custom…" has to leave that text alone rather than blank it.
      renderPopover();
      open();
      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "21 sep" },
      });
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));

      await vi.waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Custom repeat" })).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText("Type a date")).toHaveValue("21 sep");
    });

    it("saving the dialog commits through onPickRecurrence — the same door the typed phrase uses", async () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));
      await vi.waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Custom repeat" })).toBeInTheDocument();
      });

      const dialog = screen.getByRole("dialog", { name: "Custom repeat" });
      fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Every" }), {
        target: { value: "2" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      // A phrase, resolved to its first occurrence — never a second
      // rule-shaped value, and never a direct Task mutation from here.
      expect(onPickRecurrence).toHaveBeenCalledWith("every 2 days", expect.any(String));
      // `commitRepeatPhrase` (task-schedule-popover.tsx) has always closed
      // the scheduler on a successful Save — deliberate, and unlike Cancel
      // it was never issue #326's bug (that ordinary synchronous
      // `setOpen(false)` call has no dismiss-ordering race to lose).
      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });

    it("a rule with no occurrence left lands in the typed field rather than committing or vanishing, and leaves the scheduler open", async () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));
      await vi.waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Custom repeat" })).toBeInTheDocument();
      });

      const dialog = screen.getByRole("dialog", { name: "Custom repeat" });
      fireEvent.click(within(dialog).getByRole("radio", { name: "On date (inclusive)" }));
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Repeat until date" }), {
        target: { value: "01/01/2020" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      // Nothing is committed — the rule's bound is already in the past, so
      // it has no occurrence to land on. The phrase is not dropped either:
      // it goes into the field that renders this grammar's own refusal, so
      // Save neither lies nor looks broken.
      expect(onPickRecurrence).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("Type a date")).toHaveValue("every day ending 1 Jan 2020");
      // `handleCustomRepeatSave`'s own comment (task-schedule-popover.tsx)
      // has always said the scheduler deliberately stays open on this
      // branch — issue #326 is what actually made that true: the dialog
      // still closes itself unconditionally on submit, so before the fix
      // this branch rode the identical accidental dismiss Cancel's bug did.
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    // Issue #326: Cancel on this dialog shared the exact same bug the Time
    // dialog had — both reuse the identical `DialogPrimitive.Close` and the
    // identical popover-side guard (`classifyOutsideInteraction`). As with
    // that dialog's own Cancel test above, jsdom can't reproduce the real
    // dismiss-ordering race — the deferred, `flushSync`-wrapped outside
    // dispatch Radix runs off a real "pointerdown"/"click" pair never
    // happens under `fireEvent.click(...)` — so this only verifies the
    // wiring: Cancel never reaches `onPickRecurrence`, and `scheduler-view`
    // is still there right after.
    it("Cancel discards the draft: onPickRecurrence is never called, and the scheduler stays open (issue #326)", async () => {
      const { onPickRecurrence } = renderPopover();
      open();
      const menu = openRepeatMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));
      await vi.waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Custom repeat" })).toBeInTheDocument();
      });

      const dialog = screen.getByRole("dialog", { name: "Custom repeat" });
      fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Every" }), {
        target: { value: "2" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(onPickRecurrence).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Custom repeat" })).not.toBeInTheDocument();
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    // Issue #342 — this dialog's real opener ("Custom…") is unmounted by
    // the two-step hand-off before this dialog ever mounts, and that
    // hand-off deliberately focuses nothing (`openCustomRepeatAfterRepeat
    // CloseRef`'s own comment) — so the generic capture would have
    // nothing but `document.body` to restore to. `task-schedule-
    // popover.tsx` wires an explicit `restoreFocusTo` at the Repeat
    // trigger instead.
    it("Cancel restores focus to the Repeat trigger, not document.body (issue #342)", async () => {
      renderPopover();
      open();
      const menu = openRepeatMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));
      await vi.waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Custom repeat" })).toBeInTheDocument();
      });
      // Drains the Repeat menu's own deferred close-focus dispatch first
      // — its target is the identical Repeat trigger button this test
      // checks, so draining here (rather than asserting immediately) is
      // what keeps the later assertion honest rather than coincidentally
      // true (`dialog.test.tsx`'s own header comment; this issue's own
      // #339 history).
      await new Promise((resolve) => setTimeout(resolve, 20));

      const dialog = screen.getByRole("dialog", { name: "Custom repeat" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Repeat" }));
      expect(document.activeElement).not.toBe(document.body);
    });

    it("hides the Repeat entry point once a typed Recurrence is already resolving to a preview", () => {
      renderPopover({ dateString: "every friday" });
      open();

      expect(screen.getByTestId("scheduler-date-preview")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Repeat" })).not.toBeInTheDocument();
    });

    it("still offers Repeat when the typed text resolves to a plain date, not a recurrence", () => {
      renderPopover();
      open();

      fireEvent.change(screen.getByPlaceholderText("Type a date"), {
        target: { value: "21 sep" },
      });

      expect(screen.getByTestId("scheduler-date-preview")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Repeat" })).toBeInTheDocument();
    });

    it("Escape closes both the Repeat menu and the scheduler, the same way the Time dialog does", () => {
      const { onPickRecurrence, onPickDay } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.keyDown(menu, { key: "Escape" });

      expect(onPickRecurrence).not.toHaveBeenCalled();
      expect(onPickDay).not.toHaveBeenCalled();
      expect(screen.queryByTestId("repeat-menu")).not.toBeInTheDocument();
      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });
  });

  describe("controlled open state (issue #249)", () => {
    it("stays closed by default and opens on trigger click when uncontrolled", () => {
      renderPopover();

      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
      open();
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    it("renders open immediately when `open` is passed as true", () => {
      renderPopover({ open: true, onOpenChange: vi.fn() });

      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    it("stays closed when `open` is passed as false, even after a trigger click", () => {
      renderPopover({ open: false, onOpenChange: vi.fn() });

      open();

      expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
    });

    it("reports a day pick through onOpenChange instead of closing itself", () => {
      const onOpenChange = vi.fn();
      const { onPickDay } = renderPopover({ open: true, onOpenChange });

      fireEvent.click(screen.getByRole("button", { name: "Today Thu" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-10");
      expect(onOpenChange).toHaveBeenCalledWith(false);
      // Still open: a controlled caller decides, and this test double never
      // fed the `open` prop back in.
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });
  });

  // Issue #440: where the desktop popover opens. `computeSchedulePopover
  // Placement`'s own unit tests (schedule-popover-placement.test.ts) cover
  // the placement math itself against the ticket's measured examples; these
  // exercise the *wiring* — that this component measures the real trigger
  // and card DOM nodes at open time and hands the result to Radix — so a
  // seam only a mounted component can prove. `data-side` comes from Radix
  // itself (`PopperContent`'s own `placedSide`, driven by the `side` prop
  // this component passes through and `avoidCollisions={false}`, which
  // keeps Radix from second-guessing a placement this component already
  // computed with the real viewport in hand); `data-align-offset` is this
  // component's own, since Radix has nothing else to expose the *position*
  // along the cross axis through.
  describe("desktop popover placement (issue #440)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      // The file-wide `afterEach` above already covers `vi.unstubAllGlobals()`
      // (the `ResizeObserver` stub every test now installs).
      // `stubDesktopMeasurements`'s own header comment: an own property
      // shadowing jsdom's real `Window.prototype` accessor — deleting it
      // uncovers that accessor again for every test after this block.
      Reflect.deleteProperty(window, "innerWidth");
      Reflect.deleteProperty(window, "innerHeight");
    });

    it("opens beside the trigger, left side, top clamped to 48px, when neither below nor above fits", () => {
      stubLayout(true);
      renderPopover();
      stubDesktopMeasurements({
        // The ticket's own Reschedule-at-scroll-0 example: bottom 172, near
        // the page top, so the 250x555 card fits neither below nor above.
        trigger: { top: 140, left: 280, width: 80, height: 32 },
        card: { width: 250, height: 555 },
        viewport: { width: 1260, height: 696 },
      });

      open();

      const view = screen.getByTestId("scheduler-view");
      expect(view.getAttribute("data-side")).toBe("left");
      expect(view.getAttribute("data-align-offset")).toBe(String(48 - 140));
    });

    it("opens below, centred, when the whole card fits below the trigger", () => {
      stubLayout(true);
      renderPopover();
      stubDesktopMeasurements({
        // After 32px+ of scroll the ticket measured space below Reschedule
        // as >=555px — represented here as a trigger bottom (140) that
        // leaves 556px of a 696px-tall viewport below it.
        trigger: { top: 100, left: 600, width: 80, height: 40 },
        card: { width: 250, height: 555 },
        viewport: { width: 1260, height: 696 },
      });

      open();

      const view = screen.getByTestId("scheduler-view");
      expect(view.getAttribute("data-side")).toBe("bottom");
      // Centred: card left = trigger centre (640) - half the card width
      // (125) = 515, i.e. -85 from the trigger's own left edge (600).
      expect(view.getAttribute("data-align-offset")).toBe(String(-85));
    });

    it("opens above, centred, when a last-row trigger near the window bottom leaves no room below", () => {
      stubLayout(true);
      renderPopover();
      stubDesktopMeasurements({
        trigger: { top: 650, left: 600, width: 80, height: 30 },
        card: { width: 250, height: 555 },
        viewport: { width: 1260, height: 696 },
      });

      open();

      expect(screen.getByTestId("scheduler-view").getAttribute("data-side")).toBe("top");
    });

    it("keeps the whole card inside the macOS app's default 800x600 window instead of pushing it off-screen below", () => {
      stubLayout(true);
      renderPopover();
      stubDesktopMeasurements({
        trigger: { top: 300, left: 100, width: 80, height: 32 },
        card: { width: 250, height: 555 },
        viewport: { width: 800, height: 600 },
      });

      open();

      const view = screen.getByTestId("scheduler-view");
      // Beside, not below/above: a 555px card can't fit either way in a
      // 600px-tall window from a mid-page trigger.
      expect(view.getAttribute("data-side")).toBe("right");
      const alignOffset = Number(view.getAttribute("data-align-offset"));
      const top = 300 + alignOffset;
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + 555).toBeLessThanOrEqual(600);
    });

    it("opens on the right side, flush, when there is no room to the trigger's left", () => {
      stubLayout(true);
      renderPopover();
      stubDesktopMeasurements({
        trigger: { top: 140, left: 100, width: 80, height: 32 }, // left (100) < card width (250)
        card: { width: 250, height: 555 },
        viewport: { width: 1260, height: 696 },
      });

      open();

      expect(screen.getByTestId("scheduler-view").getAttribute("data-side")).toBe("right");
    });

    // The ticket's own last acceptance criterion: "Nothing on the page
    // moves when the picker opens." Unchanged by issue #440's own placement
    // work (`Popover`/`PopoverContent` were already a portalled, `position:
    // fixed` overlay before this ticket) but not previously asserted here —
    // a regression guard against a future change (e.g. dropping
    // `avoidCollisions` or the portal itself) silently turning this back
    // into a layout-affecting element.
    it("floats over the page — fixed-position, not a layout sibling of the trigger", () => {
      stubLayout(true);
      renderPopover();
      stubDesktopMeasurements({
        trigger: { top: 100, left: 600, width: 80, height: 40 },
        card: { width: 250, height: 555 },
        viewport: { width: 1260, height: 696 },
      });

      open();

      const view = screen.getByTestId("scheduler-view");
      // Radix's own Popper wrapper (`@radix-ui/react-popper`'s
      // `PopperContent`) is the one DOM node whose inline style actually
      // carries `position: fixed` — this card's own immediate parent.
      const wrapper = view.parentElement;
      expect(wrapper?.hasAttribute("data-radix-popper-content-wrapper")).toBe(true);
      expect(wrapper?.style.position).toBe("fixed");
      // Not a DOM sibling of the trigger's own parent, i.e. not part of the
      // page's normal layout flow — Radix portals `Popover.Content` to
      // `document.body` regardless of where `trigger` itself renders.
      const trigger = screen.getByRole("button", { name: "Pick a date" });
      expect(view.parentElement?.parentElement).not.toBe(trigger.parentElement);
    });

    // Issue #440's own real-browser regression, found after this ticket's
    // first landing (verified in a real browser, 3/3): the card was briefly
    // visible BELOW the trigger, overflowing the viewport, before jumping
    // to the correct beside position — `task-schedule-popover.tsx`'s own
    // comment above its placement effect has the full root-cause writeup.
    // jsdom's total absence of real layout is exactly why none of the six
    // tests above ever caught it: every measurement there, right or wrong,
    // resolves through the identical zero-cost synchronous path, so there
    // was never a "short reading, then the real one" to be wrong *between*.
    // These two pin the two mechanisms the fix actually added.
    describe("re-measurement (issue #440's real-browser jump)", () => {
      it("re-evaluates the side when the card's real height lands after a shorter first reading", () => {
        stubLayout(true);
        renderPopover();
        const { setCardSize, triggerResize } = stubDesktopMeasurements({
          trigger: { top: 140, left: 280, width: 80, height: 32 },
          // Short, but non-zero — content genuinely not at its final
          // height yet (a typed-preview line not showing yet, the Repeat
          // control's two-part layout not swapped in yet): a real
          // measurement, just an early one — the field defect's own shape,
          // not a "not laid out at all" one.
          card: { width: 250, height: 200 },
          viewport: { width: 1260, height: 696 },
        });

        open();

        const view = screen.getByTestId("scheduler-view");
        // The field defect's own first frame: a short card genuinely
        // "fits below" (172 + 200 ≤ 696), so this is shown — correctly,
        // for what was measured — at the wrong side for the card's real
        // height.
        expect(view.getAttribute("data-side")).toBe("bottom");
        expect(view.style.visibility).toBe("visible");

        setCardSize({ width: 250, height: 555 }); // the card's real height
        triggerResize(view);

        // 172 + 555 > 696 (no longer fits below) and 140 - 555 < 0
        // (doesn't fit above either) — left, the same geometry `opens
        // beside the trigger...` above already established.
        expect(view.getAttribute("data-side")).toBe("left");
      });

      it("re-evaluates the side on a page scroll while the popover stays open", async () => {
        stubLayout(true);
        renderPopover();
        const { setTrigger } = stubDesktopMeasurements({
          trigger: { top: 100, left: 600, width: 80, height: 40 },
          card: { width: 250, height: 555 },
          viewport: { width: 1260, height: 696 },
        });

        open();

        const view = screen.getByTestId("scheduler-view");
        expect(view.getAttribute("data-side")).toBe("bottom");

        // Stands in for the page scrolling while the popover stays open —
        // a real scroll moves the trigger's own viewport-relative rect the
        // identical way; the "scroll" event is what tells this component
        // to re-read it, per `task-schedule-popover.tsx`'s own capture-
        // phase `window` listener.
        setTrigger({ top: 650, left: 600, width: 80, height: 30 });
        await act(async () => {
          window.dispatchEvent(new Event("scroll"));
          // rAF-throttled (that same listener's own comment) — one real
          // frame is what flushes it, the identical pattern use-pinned-
          // scroll.test.tsx's own rAF-driven assertions already use.
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });

        // 680 + 555 > 696 (no longer fits below); 650 - 555 ≥ 0 (fits
        // above) — the same "last-row trigger near the bottom" geometry
        // `opens above, centred...` above already established.
        expect(view.getAttribute("data-side")).toBe("top");
      });

      // Issue #440's own second real-browser finding: even with the fixes
      // above, every BESIDE case still showed one wrong-shaped frame
      // (below, overflowing the viewport) before snapping to the correct
      // spot — `task-schedule-popover.tsx`'s own header comment above
      // `useLayoutEffect` has the full mechanism (Radix's own async
      // `computePosition()` lagging one frame behind a prop change). The
      // fix moved the correct computation to the FIRST render, before
      // `PopoverContent` mounts at all, using the trigger's real rect plus
      // a card size known WITHOUT mounting the card (`cardSizeFromCssTokens`
      // — CSS-token-derived in jsdom's own no-real-stylesheet case, which
      // resolves to a documented, literal fallback: 250×555, issue #436's
      // own fixed five-option baseline). This test proves that render
      // actually happened, and with the right numbers — not merely that
      // the FINAL state converges there (every test above already shows
      // that) — by spying on `computeSchedulePopoverPlacement` itself and
      // reading its very first call, before this popover's own post-mount
      // measurement effect could have run at all.
      it("computes the correct beside placement on the FIRST render, before the post-mount measurement effect ever runs", () => {
        stubLayout(true);
        renderPopover();
        // The real, post-mount card size deliberately differs from the
        // 250×555 CSS-token fallback above, so the two call sites are
        // distinguishable by their own `card` argument alone.
        stubDesktopMeasurements({
          trigger: { top: 140, left: 280, width: 80, height: 32 },
          card: { width: 250, height: 600 },
          viewport: { width: 1260, height: 696 },
        });
        const computeSpy = vi.spyOn(schedulePopoverPlacement, "computeSchedulePopoverPlacement");

        open();

        expect(computeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        const firstCall = computeSpy.mock.calls.at(0);
        // The render-time estimate's own card argument — the CSS-token
        // fallback (555), not the stubbed real measurement (600): proof
        // this call happened before `contentEl` was ever read.
        expect(firstCall?.[1]).toEqual({ width: 250, height: 555 });
        const firstResult = computeSpy.mock.results.at(0)?.value;
        expect(firstResult?.side).toBe("left");

        // And a later call — the post-mount correction path — did use the
        // real, stubbed measurement, confirming that path still runs too
        // (`re-evaluates the side when the card's real height lands...`,
        // above, already covers what it does when the two disagree).
        expect(computeSpy.mock.calls.some((call) => call[1].height === 600)).toBe(true);

        // What was actually on screen matches the FIRST call's own result
        // — this open never showed anything else.
        const view = screen.getByTestId("scheduler-view");
        expect(view.getAttribute("data-side")).toBe("left");
      });
    });
  });
});

// Issue #326's real fix (`classifyOutsideInteraction`, task-schedule-
// popover.tsx's own comment above `TaskSchedulePopoverProps`) classifies an
// outside interaction by its real DOM target instead of by
// `timeDialogOpen`/`customRepeatOpen` React state — state (and a ref
// mirroring it, the first attempt at this fix) loses a real dismiss-
// ordering race in a browser: Radix defers a non-modal Popover's own
// outside-pointerdown check to the click that follows Cancel's pointerdown,
// by which point `DialogPrimitive.Close`'s own `onClick` has already
// flipped that state to `false` in the same synchronous flush. jsdom never
// runs that deferred, `flushSync`-wrapped dispatch at all — `fireEvent.
// click` fires a bare "click" with no preceding "pointerdown", which is the
// event Radix's own outside-detection actually keys off, so no jsdom test
// (this file's `fireEvent.click(...Cancel...)` tests included, see their
// own comments) can exercise the race itself, fixed or not. What jsdom
// *can* exercise honestly is the classification `classifyOutsideInteraction`
// reduces to — `isOwnedPortalTarget`, a pure function of a DOM node — in
// isolation, with real elements built by hand rather than through Radix's
// own event pipeline. The real check is that this still holds in a browser
// (see this ticket's own commit message for what was driven there).
describe("isOwnedPortalTarget (issue #326's target classification, tested directly)", () => {
  function elementWithTestId(testId: string): HTMLElement {
    const el = document.createElement("div");
    el.setAttribute("data-testid", testId);
    document.body.appendChild(el);
    return el;
  }

  it("is true for the Time dialog's own root node", () => {
    const dialog = elementWithTestId("time-dialog");
    expect(isOwnedPortalTarget(dialog)).toBe(true);
  });

  it("is true for a descendant of the Custom-repeat dialog's own root node — e.g. its Cancel/Save buttons", () => {
    const dialog = elementWithTestId("custom-repeat-dialog");
    const cancelButton = document.createElement("button");
    dialog.appendChild(cancelButton);
    expect(isOwnedPortalTarget(cancelButton)).toBe(true);
  });

  // The Custom-repeat dialog's own "On date" calendar is itself a second,
  // independently-portalled Radix Popover (task-custom-repeat-dialog.tsx's
  // own `custom-repeat-date-popover`) — a portal breaks DOM containment at
  // every level it's used, not just the first, so this needs its own
  // `data-testid` in `OWNED_PORTAL_SELECTOR`, not just the dialog's.
  it("is true for a day cell inside the Custom-repeat dialog's own end-date calendar popover", () => {
    const calendarPopover = elementWithTestId("custom-repeat-date-popover");
    const dayCell = document.createElement("button");
    calendarPopover.appendChild(dayCell);
    expect(isOwnedPortalTarget(dayCell)).toBe(true);
  });

  it("is false for a node outside every owned dialog — a genuine outside click", () => {
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    expect(isOwnedPortalTarget(outside)).toBe(false);
  });

  it("is false for null and for a non-Element EventTarget (the shape `originalEvent.target` is typed to allow)", () => {
    expect(isOwnedPortalTarget(null)).toBe(false);
    expect(isOwnedPortalTarget(window)).toBe(false);
  });
});
