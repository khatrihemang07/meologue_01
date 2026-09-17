/**
 * The Upcoming week strip (issue #343) — a Monday-start calendar week
 * containing "today," rendered above Upcoming's own day sections. Built
 * on `@meologue/core`'s `upcomingWeekStrip()` alone, mirroring how
 * `UpcomingView` itself is "built entirely on `upcoming()`/
 * `upcomingDayHeading()`" (that file's own header comment) — this
 * component never decides the week's range or which day carries a dot,
 * only how to lay out what core already decided.
 *
 * **Two independent per-day states, not one** — the live device
 * measurement issue #343's own tracking comment records (Decision 2):
 * tapping ANY day, including one carrying nothing, selects it; "today"
 * and "selected" are tracked separately, so today keeps its own
 * (unfilled) treatment even while some other day is selected. `today`
 * is derived here from `now` directly (`now.slice(0, 10)`), never from
 * `selectedDayKey`, which is exactly what keeps the two independent.
 *
 * **Every day in the range is addressable** (issue #343's own scope
 * note) — all seven buttons render and are selectable regardless of
 * `hasDatedTask`, unlike Upcoming's own day sections below the strip,
 * which only exist for a day something is actually planned on.
 * `UpcomingView` is what makes an empty day's tap still land somewhere
 * (its own header comment on the anchor nodes it renders for exactly
 * that day); this component only reports which dayKey was tapped.
 */

import type { Task } from "@meologue/core";
import { upcomingWeekStrip } from "@meologue/core";

export interface UpcomingWeekStripProps {
  /** Every active Task — `upcomingWeekStrip()` does its own date-only filtering, mirroring `UpcomingView`'s identical `tasks` prop into `upcoming()`. */
  tasks: Task[];
  /** A floating date-or-datetime string, the same encoding `upcoming()`/`today()` already take — only the calendar-day prefix is read. */
  now: string;
  /** The currently-selected day, independent of `now`'s own calendar day — see this file's own header comment on why the two never collapse into one piece of state. */
  selectedDayKey: string;
  /** Fired for a tap on ANY day, including one with no dot — the caller (`UpcomingView`) decides what "select" means beyond storing the key (it also scrolls). */
  onSelectDay: (dayKey: string) => void;
}

// A single letter per weekday, Sunday-indexed (`Date.UTC(...).getUTCDay()`
// convention this module already uses elsewhere in task-views.ts) — NOT
// `date-fns`'s `format(day, "EEEEE")`, the call task-schedule-popover.tsx
// uses for the identical "M T W T F S S" row: that file already pays for
// `date-fns` (its Calendar primitive needs it regardless), but
// upcoming-view.tsx does not, and local-day-key.ts's own header comment
// documents exactly this trap — a single date-fns-derived import dragging
// the library into an otherwise-`date-fns`-free eager Todo chunk. Seven
// hardcoded letters cost nothing to keep this file free of it.
const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"] as const;

// The full name, for the button's own `aria-label` — a single letter is
// legible on screen but not a meaningful accessible name on its own
// ("T" for both Tuesday and Thursday).
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function weekdayOf(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function weekdayLetter(dayKey: string): string {
  return WEEKDAY_LETTERS[weekdayOf(dayKey)] ?? "";
}

function weekdayName(dayKey: string): string {
  return WEEKDAY_NAMES[weekdayOf(dayKey)] ?? "";
}

function dayNumber(dayKey: string): number {
  return Number(dayKey.slice(8, 10));
}

export function UpcomingWeekStrip({
  tasks,
  now,
  selectedDayKey,
  onSelectDay,
}: UpcomingWeekStripProps) {
  const todayKey = now.slice(0, 10);
  const days = upcomingWeekStrip(tasks, now);

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {/* The measured "jump back to today" affordance (Decision 2): a
          box carrying today's own day number, shown only once selection
          has actually moved away from today, gone the moment today is
          re-selected — never rendered while today is already selected,
          matching the live device capture ("appears... and disappears
          when today is re-selected"). */}
      {selectedDayKey !== todayKey && (
        <div className="flex justify-end">
          <button
            type="button"
            aria-label="Jump to today"
            onClick={() => onSelectDay(todayKey)}
            className="flex size-6 items-center justify-center rounded-md border font-medium text-xs"
            style={{ borderColor: "var(--td-calendar-today)", color: "var(--td-calendar-today)" }}
          >
            {dayNumber(todayKey)}
          </button>
        </div>
      )}

      <div className="flex items-stretch justify-between">
        {days.map((day) => {
          const isSelected = day.dayKey === selectedDayKey;
          const isToday = day.dayKey === todayKey;
          return (
            <button
              key={day.dayKey}
              type="button"
              aria-pressed={isSelected}
              aria-label={`${weekdayName(day.dayKey)} ${dayNumber(day.dayKey)}${isToday ? ", today" : ""}${day.hasDatedTask ? ", has scheduled tasks" : ""}`}
              data-day-key={day.dayKey}
              onClick={() => onSelectDay(day.dayKey)}
              className="flex flex-1 flex-col items-center gap-1 rounded-md py-1"
            >
              <span aria-hidden="true" className="text-muted-foreground text-xs">
                {weekdayLetter(day.dayKey)}
              </span>
              <span
                aria-hidden="true"
                className="flex size-7 items-center justify-center rounded-full font-medium text-sm"
                style={
                  isSelected
                    ? { backgroundColor: "var(--td-calendar-selected)", color: "white" }
                    : isToday
                      ? { color: "var(--td-calendar-today)" }
                      : undefined
                }
              >
                {dayNumber(day.dayKey)}
              </span>
              <span
                aria-hidden="true"
                className="size-1 rounded-full"
                style={{
                  backgroundColor: day.hasDatedTask ? "var(--td-calendar-busy-dot)" : "transparent",
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
