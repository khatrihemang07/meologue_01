/**
 * Human-readable formatting for a Task's `date`/`deadline` strings (issue
 * #169) — pulled into its own module rather than living inside
 * task-schedule-sheet.tsx (its first caller) because task-row.tsx needs
 * the identical formatting for its own compact badge, and a component
 * importing a formatting helper out of a sibling *component* file reads
 * like an accident of where the function happened to be written first,
 * not a real dependency. Both callers get the same words for the same
 * Task, which is the entire point: a Task showing "Sep 3" in Inbox and
 * "September 3rd" in Today would read as two different dates to a reader
 * who has no reason to think this app disagrees with itself.
 */
import { hasTime } from "@meologue/core";
import { format } from "date-fns";

// `day` is always YYYY-MM-DD here (Task.date's own all-day shape, or
// Task.deadline, which is always date-only). Parsed with the local
// three-argument `Date` constructor, never `new Date(day)` —
// date-picker-sheet.tsx's own header comment names exactly the trap that
// shortcut falls into for a Device west of UTC.
function parseLocalDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return null;
  }
  const [, year, month, date] = match;
  return new Date(Number(year), Number(month) - 1, Number(date));
}

/** Formats a date-only `YYYY-MM-DD` string (a Task's `deadline`, or an all-day `date`) as e.g. "Sep 3". */
export function formatDay(day: string): string {
  const parsed = parseLocalDay(day);
  return parsed === null ? day : format(parsed, "MMM d");
}

/**
 * Formats a Task's `date` field, all-day or timed, as e.g. "Sep 3" or
 * "Sep 3, 9:00 AM". Reads the time-of-day straight off the string's own
 * `HH:MM` characters rather than through any `Date` UTC accessor — the
 * value is already floating local wall-clock time (Task.date's own doc
 * comment), so there is no timezone conversion to apply on the way to a
 * label, only two numbers to splice into a formatted `Date`.
 */
export function formatTaskDate(date: string): string {
  const day = date.slice(0, 10);
  if (!hasTime(date)) {
    return formatDay(day);
  }
  const parsed = parseLocalDay(day);
  if (parsed === null) {
    return date;
  }
  const [hours, minutes] = date.slice(11, 16).split(":").map(Number);
  parsed.setHours(hours ?? 0, minutes ?? 0);
  return format(parsed, "MMM d, h:mm a");
}
