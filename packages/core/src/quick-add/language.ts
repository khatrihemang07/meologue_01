/**
 * The seam a second language plugs into (issue #170's Part A brief:
 * "build the seam for a second language; do not build a second
 * language"). Every word table the English pack (./en.ts) fills in lives
 * here as data, not as a regex or a branch buried in the engine
 * (./rules.ts) — the engine's rule functions take a `QuickAddLanguage`
 * and build their patterns from it at call time, so nothing about
 * *which* words mean "tomorrow" or "for" is hard-coded outside this
 * shape.
 *
 * **What a second language would actually have to supply, honestly.**
 * Filling in every field below with translated words is necessary but
 * not sufficient, and it would be dishonest to imply otherwise:
 *
 * - Every field here is a flat word-to-meaning table, which is exactly
 *   right for a language that, like English, doesn't inflect these words
 *   by gender, case or number. A language that does (many do — a
 *   weekday or month name changing form depending on what it's paired
 *   with) needs either a richer table shape here or a matching/
 *   normalisation step in the engine that this interface doesn't
 *   attempt to anticipate.
 * - `dayMonthOrder` covers the one word-order ambiguity this ticket's
 *   own examples exposed (`27 Jan` vs `Jan 27`, both accepted for
 *   English) — see its own doc comment. A language whose numeric date
 *   grammar differs more radically (year-first, or a different
 *   separator convention than `/`) needs an engine change, not just a
 *   different value here.
 * - The sigil tokens (`#project`, `/section`, `%label`, `p1`-`p4`,
 *   `!reminder`, `{deadline}`, a leading `* `, `//description`) are
 *   deliberately *not* part of this interface at all: they're ASCII
 *   punctuation marks, not English words, so every language shares them
 *   unchanged. A language that wanted its own marker characters (unlikely,
 *   but not this ticket's call to foreclose) would need a second seam
 *   this interface doesn't provide.
 *
 * In short: this interface guarantees that swapping languages is a data
 * problem for every language whose grammar is "flat word tables plus
 * English's own day-before-or-after-month ambiguity," and admits plainly
 * that a language whose grammar differs more than that also needs engine
 * work, not just a new file next to ./en.ts.
 */
export interface QuickAddLanguage {
  /** BCP-47-ish tag, e.g. `"en"` — not read by the engine itself, useful for a caller choosing which pack to load. */
  code: string;

  /** Weekday name/abbreviation (lower-cased) to ISO weekday number, 1 (Monday) - 7 (Sunday) — ../date-math.ts's convention. */
  weekdays: Readonly<Record<string, number>>;
  /** Month name/abbreviation (lower-cased) to 1-12. */
  months: Readonly<Record<string, number>>;
  /** Bare relative-day word (lower-cased) to an offset in days from `now`'s calendar day — `{ today: 0, tod: 0, tomorrow: 1, tom: 1 }` for English. */
  relativeDays: Readonly<Record<string, number>>;
  /** Fuzzy time-of-day word (lower-cased) to the clock time it resolves to. */
  fuzzyTimes: Readonly<Record<string, { hour: number; minute: number }>>;
  /** `am`/`pm` marker word (lower-cased) to which half of the day it names — trivial for English (`{ am: "am", pm: "am"... }`-shaped tables exist for languages that spell it differently). */
  meridiem: Readonly<Record<string, "am" | "pm">>;
  /** The word introducing a weekday/date arithmetic offset — `"in"` for English's `in 3 days`. */
  inWord: string;
  /** The word narrowing a weekday to the current week — `"this"` for English's `this fri`. */
  thisWord: string;
  /** The word pushing a weekday into the following week — `"next"` for English's `next monday`. */
  nextWord: string;
  /** Arithmetic unit word (lower-cased, singular or plural) to the unit it names. */
  arithmeticUnits: Readonly<Record<string, "days" | "weeks" | "months" | "years">>;
  /** The word introducing a duration — `"for"` for English's `for 45min`. */
  durationWord: string;
  /** Duration unit word (lower-cased) to whether it means minutes or hours. */
  durationUnits: Readonly<Record<string, "minutes" | "hours">>;
  /**
   * Bare single-word recurrence keywords this parser merely *flags* as
   * recurrence-shaped, without attempting to resolve them — see
   * ./rules.ts's recurrence rule for the full reasoning on why this
   * parser stops at recognition and leaves resolution to
   * ../recurrence/. `{ daily: true, weekly: true, monthly: true,
   * yearly: true, fortnightly: true, biweekly: true }`-shaped for
   * English; the values themselves are unused, only the keys matter
   * (a `Record<string, true>` reads more plainly at the call site than
   * a `Set` a language-pack author has to remember to construct).
   */
  recurrenceWords: Readonly<Record<string, true>>;
  /**
   * `"day-month"` (English's own preference, matching this ticket's own
   * `27 Jan`/`27/1/2026` examples) or `"month-day"`. Governs two things
   * this parser has to pick one convention for or refuse to parse at
   * all: which of `27 Jan`/`Jan 27` word orders is *also* accepted for
   * the numeric `D/M/YYYY` form (both word orders are always accepted
   * for the worded form — `Jan 27` and `27 Jan` both parse for English
   * regardless of this setting — this only disambiguates the numeric
   * `\d+/\d+/\d+` form, which has no month name to read the order off
   * unambiguously).
   */
  dayMonthOrder: "day-month" | "month-day";
}
