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
    evening: { hour: 18, minute: 0 },
    night: { hour: 21, minute: 0 },
    midnight: { hour: 0, minute: 0 },
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
};
