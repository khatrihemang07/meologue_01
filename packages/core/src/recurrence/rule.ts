/**
 * The recurrence grammar's own vocabulary (issue #170) — kept as a plain
 * data shape here, separate from ./parser.ts's parsing logic and
 * ./engine.ts's date arithmetic, because this is exactly the seam the
 * issue asks for: "the token tables and the grammar rules [must stay]
 * separable from the engine" so a second language can be added later
 * without rework, even though only English is built now. A second
 * language's own parser would produce this identical RecurrenceRule
 * shape from different words (./tokens.ts's own doc comment is the other
 * half of that seam); every consumer downstream of parsing — ./engine.ts,
 * ../task-store.ts — never has to know, or care, which language wrote
 * the string that got parsed.
 */

export type Weekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

/**
 * The shape of the recurrence, independent of interval and anchor —
 * "what kind of thing repeats." `workdays` (Monday-Friday) is its own
 * kind rather than `weekdays` with all five days spelled out, because
 * Todoist's own grammar treats "every workday" as a single, distinct
 * phrase, not shorthand its parser expands into a five-day list.
 */
export type RecurrenceFrequency =
  | { readonly kind: "daily" }
  | { readonly kind: "weekly" }
  | { readonly kind: "weekdays"; readonly days: readonly Weekday[] }
  | { readonly kind: "workdays" }
  | { readonly kind: "monthly" }
  | {
      readonly kind: "monthlyOrdinalWeekday";
      /** 1-5, or -1 for "last" (./tokens.ts's ORDINAL_TOKENS, ./calendar.ts's nthWeekdayOfMonth). */
      readonly ordinal: number;
      readonly day: Weekday;
    }
  | { readonly kind: "yearly" };

export type RecurrenceUnit = "day" | "week" | "month" | "year";

/**
 * A month-and-day, deliberately without a year at parse time — "starting
 * 1 Oct" carries no year of its own, so resolving it to one concrete
 * calendar date has to wait until ./engine.ts's computeNextOccurrence
 * actually has an anchor date to resolve it against (its own
 * resolveBoundDate does that, once, rather than the parser guessing a
 * year that a later computation might disagree with). `year` is present
 * for the one case the grammar does supply it explicitly ("starting 1 Oct
 * 2026").
 */
export interface MonthDay {
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly year: number | null;
}

export interface RecurrenceRule {
  readonly frequency: RecurrenceFrequency;
  /** Repeat-count multiplier — "every 3 months" is {kind:"monthly", interval:3}; "every other week" is {kind:"weekly", interval:2}. Always >= 1. */
  readonly interval: number;
  /**
   * "due" or "completion" — already resolved from the literal `!` and the
   * day/week exception by ./parser.ts's resolveAnchor, so a consumer of a
   * parsed rule never has to re-derive that exception itself. This is
   * exactly the detail issue #170 names as "the one most descriptions get
   * wrong," which is the reason it's resolved once, here, rather than
   * left for every caller to re-check the bang and the frequency kind
   * together.
   */
  readonly anchor: "due" | "completion";
  /** HH:MM, 24-hour, or null for an all-day rule ("every day" vs "every day at 9am"). */
  readonly time: string | null;
  readonly startBound: MonthDay | null;
  readonly endBound: MonthDay | null;
  readonly durationBound: { readonly count: number; readonly unit: RecurrenceUnit } | null;
}

/**
 * A refusal is a value, never a throw — see ../recurrence.ts's module doc
 * comment for why: a caller (ultimately, whatever renders the add field's
 * live highlight) needs to distinguish "didn't parse" from "parsed" by
 * inspecting `kind`, not by wrapping every call in a try/catch for input
 * a user can simply type.
 */
export type RecurrenceParseResult =
  | { readonly kind: "parsed"; readonly rule: RecurrenceRule }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The two dates ./engine.ts's computeNextOccurrence needs to resolve a
 * rule into a concrete next date. Not one "reference date," despite how
 * the issue's own shorthand puts it ("the engine takes the string and a
 * reference date") — see ../recurrence.ts's module doc comment for why
 * that shorthand hides an unavoidable second date once due-anchored and
 * completion-anchored rules both have to be computed by the same
 * function.
 */
export interface RecurrenceReference {
  /**
   * The Task's current `date` before this completion, in the same
   * floating encoding as Task.date (../task-types.ts) — the phase anchor
   * for a due-anchored rule (`rule.anchor === "due"`), ignored for a
   * completion-anchored one. `null` when the Task has never had a date
   * (first-time scheduling): the anchor then falls back to `now`, since
   * there is nothing else to anchor a due-anchored rule to yet.
   */
  readonly dueDate: string | null;
  /**
   * "Today," in the same floating encoding — the anchor for a
   * completion-anchored rule, and always the floor: only a date strictly
   * after `now` is ever returned by computeNextOccurrence, which is what
   * "only future dates are ever scheduled" means in practice.
   */
  readonly now: string;
}

/**
 * What computing a next occurrence produces once a rule has parsed:
 * either a concrete next date, or `"ended"` when a bounded rule (a
 * `starting`/`ending`/`for` clause) has no occurrence left inside its own
 * window. `"refused"` never reaches this type directly — it's
 * RecurrenceParseResult's own outcome — but ../recurrence.ts's top-level
 * nextOccurrence() folds both steps into one call, so its own return type
 * has to carry all three.
 */
export type RecurrenceOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "occurrence"; readonly date: string }
  | { readonly kind: "ended" };
