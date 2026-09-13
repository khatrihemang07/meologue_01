/**
 * `TaskSchedulePopover`'s own suite (issue #227). `now` is pinned to
 * 2026-09-10 (a Thursday) throughout — the exact reference instant
 * `docs/reference/todoist/scheduler-and-priority.md` was captured against
 * ("today" = 10 Sep 2026, Thursday) — so every hint/preview asserted here
 * is checked against the ledger's own measured values, not values this
 * suite invented independently of the reference capture.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskSchedulePopover } from "./task-schedule-popover";

const NOW = new Date(2026, 8, 10, 12, 0); // Thu 10 Sep 2026, local noon

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

describe("TaskSchedulePopover", () => {
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

  describe("calendar (SCHED-06 through SCHED-10)", () => {
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

  describe("Add a time (issue #249 — relocated from task-schedule-sheet.tsx)", () => {
    it("renders no toggle until a date is set", () => {
      renderPopover({ dateDay: null });
      open();

      expect(screen.queryByText("Add a time")).not.toBeInTheDocument();
    });

    it("shows the toggle unchecked and no time input when dateTime is null", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();

      expect(screen.getByLabelText("Add a time")).not.toBeChecked();
      expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
    });

    it("shows the time input, seeded with the existing value, once a time is set", () => {
      renderPopover({ dateDay: "2026-09-05", dateTime: "14:30" });
      open();

      expect(screen.getByLabelText("Add a time")).toBeChecked();
      expect(screen.getByLabelText("Time")).toHaveValue("14:30");
    });

    it("checking the toggle calls onSetTime with a default time", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();

      fireEvent.click(screen.getByLabelText("Add a time"));

      expect(onSetTime).toHaveBeenCalledWith("09:00");
    });

    it("unchecking the toggle calls onSetTime with null", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: "09:00" });
      open();

      fireEvent.click(screen.getByLabelText("Add a time"));

      expect(onSetTime).toHaveBeenCalledWith(null);
    });

    it("changing the time input calls onSetTime with the new value", () => {
      const { onSetTime } = renderPopover({ dateDay: "2026-09-05", dateTime: "09:00" });
      open();

      fireEvent.change(screen.getByLabelText("Time"), { target: { value: "16:00" } });

      expect(onSetTime).toHaveBeenCalledWith("16:00");
    });

    it("toggling the time never calls onPickDay and never closes the popover", () => {
      const { onPickDay } = renderPopover({ dateDay: "2026-09-05", dateTime: null });
      open();

      fireEvent.click(screen.getByLabelText("Add a time"));

      expect(onPickDay).not.toHaveBeenCalled();
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
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

    it("'Custom…' focuses the 'Type a date' input instead of committing anything, and leaves the scheduler open", async () => {
      const { onPickRecurrence, onPickDay } = renderPopover();
      open();
      const menu = openRepeatMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));

      // The focus hand-off happens on the menu's own `onCloseAutoFocus`
      // (issue #255's own precedent) — real, not synthetic in jsdom, so
      // it lands asynchronously once Radix tears the menu down.
      await vi.waitFor(() => {
        expect(screen.getByPlaceholderText("Type a date")).toHaveFocus();
      });
      expect(onPickRecurrence).not.toHaveBeenCalled();
      expect(onPickDay).not.toHaveBeenCalled();
      expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    });

    it("'Custom…' leaves whatever text is already typed in place — it only focuses, never clears or resets", async () => {
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
        expect(screen.getByPlaceholderText("Type a date")).toHaveFocus();
      });
      expect(screen.getByPlaceholderText("Type a date")).toHaveValue("21 sep");
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
