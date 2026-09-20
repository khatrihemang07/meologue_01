import type { QuickAddLanguage } from "./language";

/**
 * The English word tables — see ./language.ts's own header comment for
 * what a second language would need to supply alongside a file shaped
 * like this one. Every value below was chosen for issue #170's own
 * worked examples (`27 Jan`, `tod`, `this fri`, `morning`)
 * rather than an attempt at exhaustive English coverage — a form not in
 * ../quick-add.test.ts's table is a form this pack doesn't claim to
 * recognise.
 */
export const englishQuickAddLanguage: QuickAddLanguage = {
  code: "en",

  weekdays: {
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
    sunday: 7,
    sun: 7,
  },

  months: {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  },

  relativeDays: {
    today: 0,
    tod: 0,
    tomorrow: 1,
    tom: 1,
    tmr: 1,
    // Issue #382's own corpus row — "yesterday" wasn't in this table at
    // all, so it fell through to plain text. No abbreviation is added
    // alongside it: none was measured, and "tod"/"tom" are themselves
    // typed shortenings this table already had before #382, not a
    // pattern to extend without evidence.
    yesterday: -1,
  },

  // Defaults chosen for a plausible clock time under each word, not a
  // claim about what any individual user means by "morning" — a Task
  // parsed with a fuzzy time is exactly the kind of thing the Composer
  // shows back to the user for confirmation (issue #170's Part D, not
  // this module's concern) rather than something this parser has to get
  // universally right on the first guess.
  fuzzyTimes: {
    morning: { hour: 9, minute: 0 },
    noon: { hour: 12, minute: 0 },
    afternoon: { hour: 15, minute: 0 },
    // Issue #382's own corpus row: measured against the live app as
    // 19:00, not the 18:00 this table previously guessed — D1's clone
    // standard takes the measurement over the earlier, unverified guess.
    evening: { hour: 19, minute: 0 },
    night: { hour: 21, minute: 0 },
    midnight: { hour: 0, minute: 0 },
    // Issue #382: "tonight" wasn't in this table at all.
    tonight: { hour: 22, minute: 0 },
  },

  meridiem: {
    am: "am",
    "a.m.": "am",
    pm: "pm",
    "p.m.": "pm",
  },

  inWord: "in",
  thisWord: "this",
  nextWord: "next",
  lastWord: "last",

  arithmeticUnits: {
    day: "days",
    days: "days",
    week: "weeks",
    weeks: "weeks",
    month: "months",
    months: "months",
    year: "years",
    years: "years",
  },

  // Issue #382's own corpus row ("in three days") — see
  // QuickAddLanguage.numberWords' own doc comment for why this is a
  // small closed set, not a general number-word parser.
  numberWords: {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  },

  // Deliberately small — see ./language.ts's own doc comment on this
  // field for why full recurrence-grammar words ("every 3rd friday")
  // never belong in this table at all: ../recurrence/ owns that grammar,
  // and this parser only flags that a recurrence-shaped span exists.
  // These are exactly the bare words Todoist's own quick-add treats the
  // same way, which is also what "Create monthly report" (this parser's
  // own required test case) needs to be recognised at all.
  recurrenceWords: {
    daily: true,
    weekly: true,
    fortnightly: true,
    biweekly: true,
    monthly: true,
    yearly: true,
    annually: true,
  },

  dayMonthOrder: "day-month",

  weekendWord: "weekend",
  theWeekendWord: "the",

  // February 14, October 31, January 1, December 31 — verified against
  // .scratch/todoist-add-todo/research.md's own holiday table (issue
  // #366); no corpus row measures these directly (the 117-row capture
  // pass never typed one), so this table is the ticket's documented
  // vocabulary, not a `data-match-id`-traced value like the rest of this
  // file's dates.
  holidays: {
    valentine: { month: 2, day: 14 },
    halloween: { month: 10, day: 31 },
    "new year day": { month: 1, day: 1 },
    "new year eve": { month: 12, day: 31 },
  },
};
