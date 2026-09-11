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
  render(
    <TaskSchedulePopover
      trigger={<button type="button">Pick a date</button>}
      dateDay={null}
      dateString={null}
      datesWithTasks={new Map()}
      now={NOW}
      onPickDay={onPickDay}
      onPickRecurrence={onPickRecurrence}
      {...props}
    />,
  );
  return { onPickDay, onPickRecurrence };
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Pick a date" }));
}

describe("TaskSchedulePopover", () => {
  describe("quick options (SCHED-02/03)", () => {
    it("renders Today/Tomorrow/This weekend/Next week with the exact captured hints, in order", () => {
      renderPopover();
      open();

      // Exact wording from scheduler-and-priority.md §2's own table.
      expect(screen.getByRole("button", { name: "Today Thu" })).toHaveAccessibleName("Today Thu");
      expect(screen.getByRole("button", { name: "Tomorrow Fri" })).toHaveAccessibleName(
        "Tomorrow Fri",
      );
      expect(screen.getByRole("button", { name: "This weekend Sat" })).toHaveAccessibleName(
        "This weekend Sat",
      );
      expect(screen.getByRole("button", { name: "Next week Mon 14 Sep" })).toHaveAccessibleName(
        "Next week Mon 14 Sep",
      );

      const view = screen.getByTestId("scheduler-view");
      const names = within(view)
        .getAllByRole("button")
        .map((button) => button.textContent ?? "");
      const todayIdx = names.findIndex((name) => name.startsWith("Today"));
      const tomorrowIdx = names.findIndex((name) => name.startsWith("Tomorrow"));
      const weekendIdx = names.findIndex((name) => name.startsWith("This weekend"));
      const nextWeekIdx = names.findIndex((name) => name.startsWith("Next week"));
      expect(todayIdx).toBeGreaterThanOrEqual(0);
      expect(todayIdx).toBeLessThan(tomorrowIdx);
      expect(tomorrowIdx).toBeLessThan(weekendIdx);
      expect(weekendIdx).toBeLessThan(nextWeekIdx);
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

    it("'This weekend' commits the coming Saturday", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: "This weekend Sat" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-12");
    });

    it("'Next week' commits the coming Monday", () => {
      const { onPickDay } = renderPopover();
      open();

      fireEvent.click(screen.getByRole("button", { name: "Next week Mon 14 Sep" }));

      expect(onPickDay).toHaveBeenCalledWith("2026-09-14");
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
      // this file's own styling override.
      expect(document.querySelector('[data-day="2026-09-10"]')).toHaveAttribute(
        "data-today",
        "true",
      );
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
});
