/**
 * `TaskSchedulePopover`'s own suite (issue #227). `now` is pinned to
 * 2026-09-10 (a Thursday) throughout — the exact reference instant
 * `meologue-reference/todoist/scheduler-and-priority.md` was captured against
 * ("today" = 10 Sep 2026, Thursday) — so every hint/preview asserted here
 * is checked against the ledger's own measured values, not values this
 * suite invented independently of the reference capture.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WIDE_LAYOUT_QUERY } from "@/hooks/use-wide-layout";
import { isOwnedPortalTarget, TaskSchedulePopover } from "./task-schedule-popover";

const NOW = new Date(2026, 8, 10, 12, 0); // Thu 10 Sep 2026, local noon

/**
 * Pins which shell the component renders in (issue #282).
 *
 * `test/setup.ts`'s global stub answers `false` to every query but
 * `(hover: hover)`, which includes the wide-layout breakpoint — so without
 * this, every test below silently exercises the *bottom sheet* rather than
 * the anchored popover. That is not hypothetical: when the narrow variant
 * landed, all 59 assertions in this file kept passing while testing the
 * other shell entirely, because they query by `data-testid="scheduler-view"`
 * and by role, and both shells satisfy both. Assert the property, not the
 * difference — and state which shell you meant.
 */
function stubLayout(wide: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(hover: hover)" || (wide && query === WIDE_LAYOUT_QUERY),
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

describe("shell by breakpoint (issue #282)", () => {
  it("renders an anchored popover at wide widths", () => {
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

  it("renders a bottom sheet below the wide breakpoint", () => {
    stubLayout(false);
    renderPopover();
    open();

    const view = screen.getByTestId("scheduler-view");
    expect(view.getAttribute("data-slot")).toBe("sheet-content");
    expect(screen.getByRole("dialog")).toBe(view);
  });

  it("gives the narrow sheet a visible Date title, as Todoist Android's has", () => {
    stubLayout(false);
    renderPopover();
    open();

    // Both a parity row (ASCHED-01) and Radix Dialog's own accessible-name
    // requirement, satisfied by the same element.
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

  describe("quick options (SCHED-02/03)", () => {
    it("renders Today/Tomorrow/Next week/Next weekend with the exact captured hints, in order", () => {
      renderPopover();
      open();

      // Wording and order from parity-ledger.md SCHED-02, driven live on
      // Sat 12 Sep 2026 — Today (Sat)/Tomorrow (Sun)/Next week (Mon 14
      // Sep)/Next weekend (Sat 19 Sep). This suite is pinned to Thu 10 Sep
      // instead (the original reference-capture instant, still used
      // throughout the rest of this file), so the exact hint strings below
      // are this test's own — Today/Tomorrow read a bare weekday, Next
      // week/Next weekend read a full date, matching what the row records
      // for each slot.
      expect(screen.getByRole("button", { name: "Today Thu" })).toHaveAccessibleName("Today Thu");
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toHaveAccessibleName(
        "Tomorrow Fri",
      );
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toHaveAccessibleName(
        "Next week Mon 14 Sep",
      );
      // From Thu 10 Sep, the next Saturday strictly after "now" is 12 Sep
      // — see the component's own `nextWeekend` comment for why this is
      // the same date-fns call the row's Sat-12-Sep data point verifies.
      expect(screen.getByRole("button", { name: "Next weekend Sat 12 Sep" })).toHaveAccessibleName(
        "Next weekend Sat 12 Sep",
      );

      const view = screen.getByTestId("scheduler-view");
      // Read order off `aria-label` rather than `textContent` — the label
      // and hint sit in two sibling `<span>`s with no literal whitespace
      // between them in the DOM (this file's own QuickOption comment), so
      // `textContent` for "Next week" and "Next weekend" concatenate to
      // "Next weekMon 14 Sep" and "Next weekendSat 12 Sep" respectively,
      // which `startsWith` can't tell apart reliably; `aria-label` is set
      // explicitly with a real space and has no such ambiguity.
      const names = within(view)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? "");
      const todayIdx = names.findIndex((name) => name.startsWith("Today"));
      const tomorrowIdx = names.findIndex((name) => name.startsWith("Tomorrow"));
      const nextWeekIdx = names.findIndex((name) => name.startsWith("Next week "));
      const nextWeekendIdx = names.findIndex((name) => name.startsWith("Next weekend"));
      expect(todayIdx).toBeGreaterThanOrEqual(0);
      expect(todayIdx).toBeLessThan(tomorrowIdx);
      expect(tomorrowIdx).toBeLessThan(nextWeekIdx);
      expect(nextWeekIdx).toBeLessThan(nextWeekendIdx);
    });

    it("offers no 'No Date' option until a date is already set (SCHED-03)", () => {
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

    it("drops the quick option matching the Task's current date (SCHED-03)", () => {
      // Todoist: a Task already due today drops "Today", leaving Tomorrow
      // · Next week · Next weekend · No Date (parity-ledger.md SCHED-03).
      renderPopover({ dateDay: "2026-09-10" });
      open();

      expect(screen.queryByRole("button", { name: "Today Thu" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next weekend Sat 12 Sep" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();
    });

    it("drops 'Next week' when the Task is already due next Monday, generalising the rule beyond Today", () => {
      renderPopover({ dateDay: "2026-09-14" });
      open();

      expect(
        screen.queryByRole("button", { name: "Next week Mon 14 Sep" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Today Thu" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next weekend Sat 12 Sep" })).toBeInTheDocument();
    });

    it("drops a slot that lands on the same day as an earlier one, as Todoist does on a Sunday (SCHED-02)", () => {
      // flow11-R1-SCHED-02-03-07-both.json: on Sun 13 Sep Todoist read
      // Today · Tomorrow · Next weekend — Next week (Mon 14 Sep) is Tomorrow.
      renderPopover({ now: new Date(2026, 8, 13, 12, 0) });
      open();

      expect(screen.getByRole("button", { name: "Today Sun" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tomorrow Mon" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Next week Mon/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next weekend Sat 19 Sep" })).toBeInTheDocument();
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

    it("'Next weekend' commits the next Saturday strictly after now", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: "Next weekend Sat 12 Sep" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-12");
    });

    it("'Next weekend' skips today and lands a full week out when now is itself a Saturday", () => {
      // The row's own Sat-12-Sep data point: Next weekend resolves to
      // Sat 19 Sep, not today, even though today is a Saturday.
      const SATURDAY_NOW = new Date(2026, 8, 12, 12, 0);
      const { onPickDay } = renderPopover({ now: SATURDAY_NOW });
      open();

      fireEvent.click(screen.getByRole("button", { name: "Next weekend Sat 19 Sep" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-19");
    });
  });

  describe("calendar (SCHED-06 through SCHED-10, plus the six defects measured live 2026-09-15)", () => {
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

    it("today carries no aria-current (SCHED-07, deliberate)", () => {
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

    it("today's colour utility carries `!important` so it wins over the weekend utility on a weekday's cell too (SCHED-07)", () => {
      renderPopover();
      open();

      // Thu 10 Sep 2026 is a weekday, so this cell should carry ONLY the
      // today styling, not the weekend one.
      const cell = document.querySelector('[data-day="2026-09-10"]');
      expect(cell?.className).toContain("text-[color:var(--td-calendar-today)]!");
      expect(cell?.className).not.toContain("text-muted-foreground");
    });

    it("today's colour utility still carries `!important` when today is itself a weekend day (SCHED-07 defect)", () => {
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
      // The cell is both `today` and `weekend` at once — the exact
      // collision SCHED-07 measured live. Both utilities are present on
      // the cell (this file's own `weekend`/`today` classNames both apply
      // unconditionally), and `today`'s carries the trailing `!` that
      // forces it to win the cascade regardless of Tailwind's generated
      // stylesheet order.
      //
      // NOTE ON WHAT THIS DOES NOT PROVE: jsdom never computes a cascade
      // (no stylesheet is parsed/applied), so this assertion cannot show
      // which colour actually paints — it only shows both classes are
      // present and that `today`'s carries `!important`. The real-browser
      // finding this row cites (grey rgb(204,204,204) instead of today-red
      // rgb(226,106,96)) was read via `getComputedStyle` on a live page;
      // that verification step is out of reach for this suite.
      expect(cell?.className).toContain("text-[color:var(--td-calendar-today)]!");
      expect(cell?.className).toContain("text-muted-foreground");
    });

    it("the selected day is a filled circle (SCHED-08) — the cell carries data-selected", () => {
      renderPopover({ dateDay: "2026-09-05" });
      open();

      const cell = document.querySelector('[data-day="2026-09-05"]');
      expect(cell).toHaveAttribute("data-selected", "true");
      expect(cell?.className).toContain("bg-[color:var(--td-calendar-selected)]");
    });

    it("weekends dim independently of today/selected (SCHED-10)", () => {
      renderPopover();
      open();

      // 2026-09-12 is a Saturday.
      const cell = document.querySelector('[data-day="2026-09-12"]');
      expect(cell?.className).toContain("text-muted-foreground");
    });

    it("a day carrying a Task gets the busy-dot modifier (SCHED-09)", () => {
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

  describe("Type a date (SCHED-04/05)", () => {
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

  describe("Time dialog (SCHED-11/pass2 §7 — replaces issue #249's inline 'Add a time' toggle)", () => {
    function openTimeDialog() {
      fireEvent.click(screen.getByRole("button", { name: "Time" }));
      return screen.getByRole("dialog", { name: "Select start and end time" });
    }

    it("renders no Time button until a date is set", () => {
      renderPopover({ dateDay: null });
      open();

      expect(screen.queryByRole("button", { name: "Time" })).not.toBeInTheDocument();
    });

    it("the inline time field is gone — no bare time input renders in the scheduler itself", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: "14:30" });
      open();

      expect(screen.queryByText("Add a time")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Start time")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
    });

    it("the Time button opens a dialog with Todoist's own recorded title and fields", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();

      const dialog = openTimeDialog();

      // SCHED-11 (live-audit-dom/flow3-SCHED-todoist.json): role="dialog",
      // aria-label "Select start and end time", a Start time field, and
      // Duration/Time zone deliberately not built (issue #179's removal;
      // no per-Task timezone concept exists — see task-time-dialog.tsx's
      // own header comment).
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

    // SCHED-11: pass2-2026-09-11.md §7 — "One Escape closes the Repeat/
    // Time layer and the scheduler beneath it simultaneously," unlike the
    // pre-follow-up shape where Escape closed only this dialog. Escape
    // equals Cancel (no commit) plus closing the scheduler too — Save and
    // Cancel themselves are unchanged, still returning to the scheduler
    // (the tests above this one).
    it("Escape closes both the Time dialog and the scheduler, without committing a time (SCHED-11's own follow-up)", () => {
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

  describe("Repeat menu (SCHED-14, issue #227)", () => {
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

      // NOW = Thu 10 Sep 2026. Every day/week/workday/month/year phrase
      // resolves against `now` (no `dateDay` on this Task) exactly as
      // SCHED-04's typed input would, so the weekday/day-of-month/
      // month-and-day text below is Thu 10 Sep's own, not invented.
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

      // Todoist's own recorded behaviour (scheduler-and-priority.md §7):
      // "the Repeat button disappears from the panel and is replaced by
      // the resolved preview" once a recurrence is active.
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

    // SCHED-11's own follow-up — pass2-2026-09-11.md §7 records the same
    // simultaneous close for "the Repeat/Time layer," not just the Time
    // dialog: Escape here closes the Repeat menu (Radix's own default)
    // and the scheduler beneath it together, committing nothing.
    it("Escape closes both the Repeat menu and the scheduler, per the same pass2 §7 record as the Time dialog", () => {
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
