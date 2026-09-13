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
 * grey — which is meologue-parity-docs/todoist/row-and-detail.md §1's own
 * "single most consequential finding": an overdue Task, one due today
 * and one due next year all read identically. `describeTaskDate` below
 * is the one place that now decides both words and colour for a Task's
 * `date` field, returning a `DateTone` alongside the text so task-row.tsx,
 * task-detail-view.tsx and task-schedule-sheet.tsx can't each derive a
 * slightly different answer to "is this overdue" the way three
 * independent `date < today` comparisons eventually would.
 *
 * Issue #250, driving both apps side by side, DARK theme only
 * (meologue-parity-docs/todoist/pass2-2026-09-11.md §1), measured Today and
 * Tomorrow as two more distinct colours, not a shared "upcoming" purple —
 * closing DATE-09 (parity-ledger.md), which had recorded the Today colour
 * as an explicit, flagged guess that this measurement falsifies. Tomorrow
 * gained a tone of its own (`"tomorrow"`, below) rather than folding into
 * `"upcoming"` the way it used to — pass2 §1 is also explicit that these
 * two colours are NOT fixed across Todoist's own themes (the "Todoist"
 * named theme reads `rgb(113,250,149)`/`rgb(255,180,83)` for the identical
 * two states), so `TONE_COLOUR` below is a Dark-theme replica only —
 * DATE-12 (parity-ledger.md) tracks the un-closed theme-dependence gap.
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

/**
 * Formats a date-only `YYYY-MM-DD` string (a Task's `deadline`, or an
 * all-day `date`) as e.g. "3 Sep" — day-then-month, Todoist's order
 * everywhere it renders an absolute date (Upcoming headings, the captured
 * "1 Sep": scheduler-and-priority.md §9). DATE-11 (parity-ledger.md) is
 * what measured meologue's own "Sep 21" as the divergent order; no year is
 * ever appended, in either app — scheduler-and-priority.md §9 marks "a
 * different year" an explicit GAP, never observed live, so this keeps the
 * pre-existing (also year-less) behaviour rather than inventing one.
 * Carries no tone — see this module's own header comment for why
 * `Task.deadline` stays plain.
 */
export function formatDay(day: string): string {
  const parsed = parseLocalDay(day);
  return parsed === null ? day : format(parsed, "d MMM");
}

/**
 * The five states DATE-01/03/09 (parity-ledger.md) name, plus `"none"` for
 * every date this reference corpus never put a colour on — either a Date
 * over a week out (DATE-11's "further out" row: unverified, matched only
 * against indirect evidence) or a completed Task's own muting (DATE-02:
 * completion overrides tone, it doesn't erase the row). Kept as a named
 * union, not inlined into `describeTaskDate`'s return shape alone, so a
 * caller that only cares about the *state* (not the resolved colour) has
 * something to switch on — task-schedule-sheet.tsx's Date button does
 * exactly that, below.
 *
 * `"tomorrow"` is issue #250's own addition — before it, `describeDay`
 * folded `diffDays === 1` into `"upcoming"`, the same tone the next five
 * days share, so Tomorrow could never be styled separately from a Task due
 * next Thursday even though pass2-2026-09-11.md §1 measured Todoist
 * painting the two in different colours entirely (green vs. orange,
 * neither the shared purple).
 */
export type DateTone = "overdue" | "today" | "tomorrow" | "upcoming" | "none";

const TONE_COLOUR: Record<DateTone, string> = {
  overdue: "var(--td-date-overdue)",
  // DATE-09 (parity-ledger.md): measured `rgb(37,184,76)` green, Dark
  // theme, pass2-2026-09-11.md §1 — replacing the flagged guess this
  // token used to carry (reusing `--td-date-upcoming`, falsified by the
  // same capture).
  today: "var(--td-date-today)",
  // Same capture, same section: measured `rgb(255,154,20)` orange, a
  // fourth colour distinct from both `today` and `upcoming`.
  tomorrow: "var(--td-date-tomorrow)",
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
 * name (one to six days out) are DATE-01/03/06's own measured wording —
 * "Tomorrow" carries its own tone since issue #250 (see `DateTone`'s own
 * doc comment above), distinct from the five days after it.
 * Everything past that edge — further overdue, or seven-plus days out —
 * falls back to `formatDay`'s plain day-then-month (DATE-11): DATE-06/07 (parity-ledger.md)
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
      // DATE-10 (parity-ledger.md): Todoist reads "Tomorrow 9:30 AM", no
      // comma — measured live, same session, against meologue's own
      // "Tomorrow, 9:30 AM". The comma was a reasonable-looking extension
      // this module invented, not a replayed measurement.
      text = `${text} ${format(parsed, "h:mm a")}`;
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
