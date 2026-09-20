import { hasTime } from "@meologue/core";
import { format } from "date-fns";

// `day` is always YYYY-MM-DD here (Task.date's own all-day shape).
// Parsed with the local
// three-argument `Date` constructor, never `new Date(day)` —
// lib/local-day-key.ts's own header comment (home of `localDayKey`/
// `parseDayKey`, the identical conversion pair) names exactly the trap
// that shortcut falls into for a Device west of UTC.
function parseLocalDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return null;
  }
  const [, year, month, date] = match;
  return new Date(Number(year), Number(month) - 1, Number(date));
}

export function formatDay(day: string): string {
  const parsed = parseLocalDay(day);
  return parsed === null ? day : format(parsed, "d MMM");
}

export type DateTone = "overdue" | "today" | "tomorrow" | "upcoming" | "none";

const TONE_COLOUR: Record<DateTone, string> = {
  overdue: "var(--td-date-overdue)",
  today: "var(--td-date-today)",
  // Same capture, same section: measured `rgb(255,154,20)` orange, a
  // fourth colour distinct from both `today` and `upcoming`.
  tomorrow: "var(--td-date-tomorrow)",
  upcoming: "var(--td-date-upcoming)",
  none: "var(--td-date-muted)",
};

export interface TaskDateDisplay {
  text: string;
  /** The date's own state, ignoring completion — task-schedule-sheet.tsx reads this to skip the "Clear date" affordance's own styling question entirely, since a picker button never represents a completed Task. */
  tone: DateTone;
  colour: string;
}

function describeDay(day: string, today: Date): { text: string; tone: DateTone } {
  const parsed = parseLocalDay(day);
  if (parsed === null) {
    return { text: day, tone: "none" };
  }
  const diffDays = Math.round((parsed.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) {
    return diffDays === -1
      ? { text: "Yesterday", tone: "overdue" }
      : { text: formatDay(day), tone: "overdue" };
  }
  if (diffDays === 0) {
    return { text: "Today", tone: "today" };
  }
  if (diffDays === 1) {
    return { text: "Tomorrow", tone: "tomorrow" };
  }
  if (diffDays <= 6) {
    return { text: format(parsed, "EEEE"), tone: "upcoming" };
  }
  return { text: formatDay(day), tone: "none" };
}

/** Today's own local calendar day, as midnight — the one reference point `describeDay`'s diff is taken against. A plain `new Date()` truncated to y/m/d, never UTC: "today" means the Device's own wall-clock day, the same locality `Task.date` itself is defined in (task-types.ts's own doc comment on why it's floating). */
function localToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** `describeDay`, for a bare `YYYY-MM-DD` with no Task attached — task-schedule-sheet.tsx's Date button reads a Task's current value through this rather than `formatDay`, so its own label agrees with the row's wording (issue #224's own brief: row, detail, scheduler and sidebar must agree by construction) without also inheriting a Task's completion/recurrence, neither of which a picker button represents. */
export function describeTaskDay(day: string, now: Date = new Date()): TaskDateDisplay {
  const { text, tone } = describeDay(day, localToday(now));
  return { text, tone, colour: TONE_COLOUR[tone] };
}

export function formatTaskDate(
  date: string,
  options: { now?: Date; completed?: boolean; recurring?: boolean } = {},
): TaskDateDisplay {
  const { now = new Date(), completed = false, recurring = false } = options;
  const day = date.slice(0, 10);
  const { text: dayText, tone } = describeDay(day, localToday(now));

  let text = dayText;
  if (hasTime(date)) {
    const parsed = parseLocalDay(day);
    if (parsed !== null) {
      const [hours, minutes] = date.slice(11, 16).split(":").map(Number);
      parsed.setHours(hours ?? 0, minutes ?? 0);
      text = `${text} ${format(parsed, "h:mm a")}`;
    }
  }
  if (recurring) {
    text = `${text} ↻`;
  }

  return {
    text,
    tone,
    colour: completed ? TONE_COLOUR.none : TONE_COLOUR[tone],
  };
}
