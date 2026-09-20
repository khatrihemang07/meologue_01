import type { LocalDateTimeKey } from "../local-day-key";
import type { QuickAddLanguage } from "./language";

/**
 * The quick-add parser (issue #170, Part A): turns what the user typed
 * into the add field into a structured Task and the exact spans of input
 * that produced each piece of it. Platform-free — no DOM, no clock read
 * off `Date.now()` internally (a caller passes `now`, exactly as
 * ../task-views.ts's `today()` does, for the identical reason: a pure
 * function over an explicit reference is trivially unit-testable with a
 * fixed date, where a function that reaches for the system clock itself
 * is not).
 *
 * **Recognition, not persistence.** This module never touches a
 * TaskStore and never validates against ../task-fields.ts's rules — a
 * caller that goes on to persist a QuickAddResult's fields does that
 * through the ordinary TaskStore setters, which already enforce them.
 * Duplicating that validation here would be a second place the rule could
 * drift from the first.
 */

/**
 * Every kind of span this parser recognises. Two families, and the
 * distinction matters for `QuickAddOptions.smartDates` (see
 * parse-quick-add.ts's own header comment for the full reasoning):
 *
 * - **Sigil-marked** (`project`, `section`, `label`, `priority`,
 *   `reminder`, `uncompletable`, `description`):
 *   the user typed an explicit marker — `#`, `/`, `@`, `p1`, `!`,
 *   a leading `* `, `//` — so there is no false-positive risk to
 *   guard against. These are always recognised.
 * - **Eager/natural-language** (`date`, `time`, `recurrence`): inferred
 *   from ordinary words with no marker at all — `monday`, `5pm`,
 *   `monthly` — which is exactly the family Todoist's own "Create
 *   **monthly** report" false positive belongs to. These are the ones
 *   `smartDates: false` turns off, and the ones demotion exists for.
 *
 * `duration` (`for 45min`) was a third sigil-marked kind here until issue
 * #179 removed it — Duration exists nowhere in the product any more, so
 * `for 45min` is now just ordinary words, exactly as `for 45min` would
 * have read before issue #169 ever added the field. `deadline` (`{}`)
 * was a fourth, removed by issue #377 for the identical reason: Deadline
 * itself is gone from the product (D12 — Pro-gated in Todoist, 0 Tasks
 * carried one in either live database), so `{27 jan}` is now just
 * ordinary punctuation, exactly like any other brace pair this parser
 * never assigned meaning to.
 */
export type QuickAddTokenKind =
  | "date"
  | "time"
  | "project"
  | "section"
  | "label"
  | "priority"
  | "reminder"
  | "uncompletable"
  | "description"
  | "recurrence";

interface TokenBase {
  kind: QuickAddTokenKind;
  /** Offset of the first character of this token in the original input, UTF-16 code units (`String.prototype.slice` units), matching `raw`/`input.slice(start, end)`. */
  start: number;
  /** Offset one past the last character — `input.slice(start, end) === raw`. */
  end: number;
  /** The exact substring this token matched — never re-derived by searching `input` for it again (this module's own header comment explains why that matters). */
  raw: string;
}

export type QuickAddToken =
  | (TokenBase & { kind: "date"; date: string })
  | (TokenBase & { kind: "time"; time: string })
  | (TokenBase & { kind: "project"; name: string })
  | (TokenBase & { kind: "section"; name: string })
  | (TokenBase & { kind: "label"; name: string })
  | (TokenBase & { kind: "priority"; priority: number })
  | (TokenBase & { kind: "reminder"; time: string | null })
  | (TokenBase & { kind: "uncompletable" })
  | (TokenBase & { kind: "description"; text: string })
  | (TokenBase & { kind: "recurrence" });

/** A half-open `[start, end)` span in the original input — what a caller names when it demotes a token (see `QuickAddOptions.demoted`). */
export interface QuickAddSpan {
  start: number;
  end: number;
}

export interface QuickAddResult {
  /** The original input, unmodified — every token's `start`/`end` indexes into this string. */
  input: string;
  /**
   * Every recognised token, in the order it appears in `input`. The UI's
   * live highlight renders directly off this array's spans — issue
   * #170's Part A brief is explicit that the UI must never re-find a
   * token by string-matching its `raw` text back into `input`, which
   * breaks the moment the same word appears twice.
   */
  tokens: QuickAddToken[];
  /**
   * What's left of `input` once every recognised token's `[start, end)`
   * span is removed and the surrounding whitespace is collapsed to
   * single spaces and trimmed — what a caller sets `Task.content` to.
   * Also never re-derived by searching: it's built once, here, from the
   * same span list `tokens` carries.
   */
  content: string;
  /** Merged date-and-time (`YYYY-MM-DD` or floating `YYYY-MM-DDTHH:MM`, ../task-types.ts's `Task.date` encoding), or `null` if no date-family token was recognised. */
  date: string | null;
  /** Stored 1-4 (4 most urgent) via ../task-types.ts's `storedPriorityOf` — never open-coded. Defaults to 1 ("no priority"), matching `Task.priority`'s own default. */
  priority: number;
  projectName: string | null;
  sectionName: string | null;
  /** Every recognised `@label`, in the order typed. Names, not ids — resolving a name to a Label id is a caller concern (this module has no LabelStore). */
  labelNames: string[];
  /** Floating time-of-day (`HH:MM`) from a recognised `!reminder` token, or `null` if none was recognised, or if one was but carried no time of its own. */
  reminderTime: string | null;
  /** True if the input carried a leading `* ` (issue #170's uncompletable marker). */
  uncompletable: boolean;
  /** Text after a recognised `//`, or `null`. Task has no field to persist this in yet (../task-types.ts) — carried here regardless, since recognising it is this ticket's job and storing it is a later one's. */
  description: string | null;
}

/**
 * The seam a second language plugs into — see ./language.ts for the
 * interface itself and, in its own header comment, the honest answer to
 * "what would a second language actually have to supply."
 */
export interface QuickAddOptions {
  /** Defaults to ./en.ts's `englishQuickAddLanguage`. */
  language?: QuickAddLanguage;
  /**
   * A floating `YYYY-MM-DDTHH:MM` reference instant — the same "caller
   * supplies it, this module never reads the system clock" convention
   * ../task-views.ts's `today()` uses, for the identical testability
   * reason. Required — not `?`-optional, unlike every other field below.
   * Every eager/natural-language rule (date-rules.ts's own year-less
   * "27 jan"/relative "tomorrow"/weekday resolution) reads it, and those
   * only ever run when `smartDates` is true — but this field stayed
   * required regardless of that setting even before issue #377, back when
   * `{deadline}` (sigil-marked, always active) resolved the identical
   * date grammar against it through `resolveWholePhrase`. That consumer
   * is gone now, and no other sigil-marked rule reads `now` at all
   * (`!reminder`'s own time forms don't), so `smartDates: false` alone
   * no longer has a runtime reason to need it — kept required anyway,
   * a caller that always has a `now` on hand (every real one does — this
   * is the composer's own clock) gets a compile error for forgetting it
   * rather than a working build that silently regresses the moment a
   * future sigil-marked rule reads it again.
   *
   * `LocalDateTimeKey`, not `LocalDayKey` (issue #383): a fuzzy or
   * explicit time already past on the reference day has to roll to
   * tomorrow, the way Todoist's own does — "noon" typed at 14:00 means
   * tomorrow's noon — and answering that needs to know *when* today is,
   * not only *which day*. Every real caller now hands this
   * `localDateTimeKey(new Date())` (`apps/web`'s own producer, alongside
   * `localDayKey()`) rather than `localDayKey(new Date())`; nothing
   * silently defaults to midnight, because the type itself refuses a
   * bare day.
   */
  now: LocalDateTimeKey;
  /**
   * Turns off the eager/natural-language family of rules entirely — the
   * clean call-site distinction issue #170's Part A brief asks for,
   * instead of a flag threaded through every individual rule function.
   * Defaults to `true`. Sigil-marked tokens (`#project`, `@label`, `p1`,
   * `!reminder`, leading `* `, `//`) are
   * unaffected — see QuickAddTokenKind's own doc comment for why an
   * explicit marker carries no false-positive risk to turn off.
   */
  smartDates?: boolean;
  /**
   * Spans a caller has already demoted — "this recognised span is plain
   * text after all" (issue #170's Part A brief). A candidate match whose
   * `[start, end)` exactly equals one of these is skipped, and its text
   * falls back into `content` like any other unrecognised text. See
   * ./parse-quick-add.ts's `demoteQuickAddToken` for the usual way a
   * caller builds this list from a `QuickAddResult` it already has,
   * rather than tracking spans by hand.
   */
  demoted?: readonly QuickAddSpan[];
  /**
   * Real Project names, case-insensitive, for `#project`
   * existence-checking (issue #388: `#Name` should highlight only when it
   * exactly matches something real, multi-word names included). Longest
   * exact match wins at each `#`.
   *
   * **`undefined` (the default, left out entirely) is not "no
   * restriction" — it means "no lookup available," and `matchProject`
   * falls back to its pre-#388 permissive behaviour (any run of
   * word characters after `#` counts as a project name, exactly as
   * before this issue).** This is deliberate, not an oversight: two real
   * callers of `parseQuickAdd` — the journal Composer's checklist
   * highlighting and Task-promotion, both routed through
   * `quick-add-highlight.ts` (`apps/web`) — are outside issue #388's own
   * scope (its D14) and must keep working exactly as they do today. Only
   * the Todo composer (`apps/web`'s `use-quick-add-composer.ts`) supplies
   * this field; every other caller simply never passes it, and stays on
   * the permissive path with no code of its own having to opt out. A
   * caller that DOES want the exact-match/"unknown name creates nothing"
   * behaviour must actively supply this list — even an empty one, which
   * correctly means "no known Projects yet, so nothing matches."
   */
  projectNames?: readonly string[];
  /** Same shape and the identical `undefined`-means-permissive contract as `projectNames`'s own doc comment — for `@`/`%` label sigils. */
  labelNames?: readonly string[];
  /**
   * A Project's own Section names, keyed by the Project's name,
   * lower-cased. Same `undefined`-means-permissive contract as
   * `projectNames` — supplied (even as an empty `Map`) is what switches
   * `/section` from "any word after `/`" to exact-match against whichever
   * Project the parser decides is "active" for this line (the winning
   * `#project` token in the same input, or `activeProjectName` when none
   * was typed — see ./parse-quick-add.ts's `collectCandidates` for the
   * exact sequencing). Ignored entirely on the permissive path.
   */
  sectionNamesByProject?: ReadonlyMap<string, readonly string[]>;
  /**
   * The view's ambient Project name — what `/section` falls back to
   * scoping against when no `#project` token wins in this same line.
   * `null`/absent means there is no ambient Project (e.g. Today, Inbox).
   * Only consulted when `sectionNamesByProject` is also supplied; has no
   * effect on the permissive fallback path.
   */
  activeProjectName?: string | null;
}
