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
 *
 * Issue #224 is the same principle applied to *tone*, not just wording.
 * Before it, this module rendered `MMM d` and nothing else — never
 * "Today", never "Tomorrow", never a weekday, and always in the same
 * grey — which is docs/reference/todoist/row-and-detail.md §1's own
 * "single most consequential finding": an overdue Task, one due today
 * and one due next year all read identically. `describeTaskDate` below
 * is the one place that now decides both words and colour for a Task's
 * `date` field, returning a `DateTone` alongside the text so task-row.tsx,
 * task-detail-view.tsx and task-schedule-sheet.tsx can't each derive a
 * slightly different answer to "is this overdue" the way three
 * independent `date < today` comparisons eventually would.
 *
 * `formatDay` stays exactly what it was: a plain, tone-less `MMM d`
 * formatter. It still backs `Task.deadline` everywhere that field
 * renders (task-row.tsx's "Due …", task-detail-view.tsx's Deadline
 * attribute, task-schedule-sheet.tsx's Deadline button) — DATE-08
 * (parity-ledger.md) is `blocked`, Deadline row rendering was never
 * observed against a live Todoist (Deadline is Pro-gated on the captured
 * account), so this file does not invent a tone for it. Only `Task.date`
 * — the field DATE-01 through DATE-07 actually describe — gets the
 * relative-word, coloured treatment.
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

/** Formats a date-only `YYYY-MM-DD` string (a Task's `deadline`, or an all-day `date`) as e.g. "Sep 3". Carries no tone — see this module's own header comment for why `Task.deadline` stays plain. */
export function formatDay(day: string): string {
  const parsed = parseLocalDay(day);
  return parsed === null ? day : format(parsed, "MMM d");
}

/**
 * The four states DATE-01/02/03 (parity-ledger.md) name, plus `"none"` for
 * every date this reference corpus never put a colour on — either a Date
 * over a week out (DATE-06's "further out" row is `blocked`: no such Task
 * existed in the captured account) or a completed Task's own muting
 * (DATE-02: completion overrides tone, it doesn't erase the row). Kept as
 * a named union, not inlined into `describeTaskDate`'s return shape alone,
 * so a caller that only cares about the *state* (not the resolved colour)
 * has something to switch on — task-schedule-sheet.tsx's Date button does
 * exactly that, below.
 */
export type DateTone = "overdue" | "today" | "upcoming" | "none";

const TONE_COLOUR: Record<DateTone, string> = {
  overdue: "var(--td-date-overdue)",
  // No Task in the captured account was due exactly today (DATE-06,
  // `blocked`), so there is no measured "today" colour to point at.
  // Reusing the upcoming purple rather than inventing a fourth literal —
  // Today is the diffDays === 0 edge of the identical "due soon, not yet
  // late" window the next six days already share a colour for, and this
  // module's own rule (see index.css's `[data-surface="todo"]` header
  // comment) is new tokens for what was actually measured, not for a gap.
  // Flagged here, not silently matched, so a future capture that finds
  // Todoist using a THIRD colour for Today specifically has one line to
  // change rather than a guess to first discover.
  today: "var(--td-date-upcoming)",
  upcoming: "var(--td-date-upcoming)",
  none: "var(--td-date-muted)",
};

/** What a Date renders as, resolved once so a caller never re-derives DATE-02's "completion overrides tone" rule for itself. */
export interface TaskDateDisplay {
  text: string;
  /** The date's own state, ignoring completion — task-schedule-sheet.tsx reads this to skip the "Clear date" affordance's own styling question entirely, since a picker button never represents a completed Task. */
  tone: DateTone;
  /** `TONE_COLOUR[tone]`, unless `completed` overrode it to the shared muted grey (DATE-02). Pre-resolved so every render site does `style={{ color: display.colour }}` and nothing more. */
  colour: string;
}

/**
 * The day-only core both `describeTaskDay` (a bare `YYYY-MM-DD`, for
 * task-schedule-sheet.tsx's Date button) and `describeTaskDate` (a full
 * `Task.date`, which may also carry a time) share — one comparison
 * against "today," never duplicated between a timed and an all-day path.
 *
 * Only "Yesterday" (exactly one day overdue) and "Tomorrow"/a weekday
 * name (one to six days out) are DATE-01/03's own measured wording.
 * Everything past that edge — further overdue, or seven-plus days out —
 * falls back to `formatDay`'s plain `MMM d`: DATE-06/07 (parity-ledger.md)
 * mark both "further out" and "with a time" as `blocked`, no such Task
 * existed to observe, so this is the reasonable default named in issue
 * #224's own brief rather than a second relative phrase ("2 days ago")
 * nobody watched Todoist actually produce. It happens to match the one
 * piece of indirect evidence available: the captured account's completed,
 * 9-days-overdue Task rendered as the plain "1 Sep," not a relative
 * phrase (scheduler-and-priority.md §9) — consistent with this fallback,
 * not merely unconstrained by it.
 */
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
    return { text: "Tomorrow", tone: "upcoming" };
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

/**
 * Formats a Task's `date` field, all-day or timed, with the tone DATE-01
 * through DATE-04 (parity-ledger.md) describe. Reads the time-of-day
 * straight off the string's own `HH:MM` characters rather than through any
 * `Date` UTC accessor — the value is already floating local wall-clock
 * time (Task.date's own doc comment), so there is no timezone conversion
 * to apply on the way to a label, only two numbers to splice into a
 * formatted `Date`.
 *
 * `completed`/`recurring` are read here, not left for the caller to
 * splice onto the returned text themselves, precisely so DATE-02 and
 * DATE-04 can't drift apart between call sites the way the tone itself
 * would have without this whole function existing: "append ↻, then ask
 * whether this row happens to be completed" is two independent decisions
 * a row and the detail view could easily make in a different order or not
 * at all otherwise.
 */
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
      text = `${text}, ${format(parsed, "h:mm a")}`;
    }
  }
  // DATE-04: the ↻ glyph, not the literal recurrence rule — task-row.tsx
  // still shows `Task.dateString` verbatim elsewhere on the row (its own
  // "the string is the truth" comment), so this is additive, not a
  // replacement for that transparency.
  if (recurring) {
    text = `${text} ↻`;
  }

  return {
    text,
    tone,
    // DATE-02: completion overrides tone with the shared muted grey,
    // regardless which of overdue/today/upcoming/none it started as.
    colour: completed ? TONE_COLOUR.none : TONE_COLOUR[tone],
  };
}
