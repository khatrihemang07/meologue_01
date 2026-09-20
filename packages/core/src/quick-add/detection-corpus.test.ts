import { describe, expect, it } from "vitest";
import { uiPriorityOf } from "../task-types";
import { dayKey } from "../test-support/day-key-fixture";
import corpus from "./detection-corpus.json";
import { parseQuickAdd } from "./parse-quick-add";
import type { QuickAddToken } from "./types";

/**
 * Issue #364: makes Todoist parity falsifiable, rather than a narrative
 * ledger. `./detection-corpus.json` is a *derived, minimal* copy of a
 * 117-row measurement pass against the live Todoist web app (free-tier
 * account, zero pre-existing labels/projects beyond Inbox) — captured
 * **Saturday 2026-09-19, ~13:36–14:18 IST (`Asia/Calcutta`, confirmed via
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` mid-session)**. Full
 * raw captures, screenshots and prose live in (and stay in)
 * `.scratch/todoist-add-todo/web/` — D6 in `.scratch/todoist-add-todo/
 * DECISIONS.md` is explicit that only the falsifiable claim is committed,
 * not the ledger that produced it.
 *
 * Each row's `matches[].matchId` is Todoist's own resolved value, read
 * off the live DOM's `data-match-id` attribute — not recomputed or
 * guessed here. That's what makes this a fixture rather than a claim:
 * every expectation below traces back to something the *other* app wrote
 * down about itself.
 *
 * **Reference "now"**, matching the capture window, fixed for every row
 * in this file:
 */
const NOW = dayKey("2026-09-19"); // Saturday.
const REF_YEAR = 2026;

interface CorpusMatch {
  text: string;
  matchId: string;
}
interface CorpusRow {
  input: string;
  matches: CorpusMatch[];
}
const CORPUS = corpus as CorpusRow[];

/**
 * The token kinds Todoist's `data-testid="natural-language-match"` spans
 * can actually be compared against. `label`, `reminder`, `uncompletable`
 * and `description` are deliberately excluded, not overlooked:
 *
 * - **`label`**: this capture account has zero pre-existing labels, so
 *   `@word` never resolves to anything in Todoist — it opens a *separate*
 *   autocomplete popup (`content-editor-suggestions-dropdown`), never an
 *   inline `natural-language-match` span (`.scratch/todoist-add-todo/
 *   web/02-detection-corpus.md`'s "Labels" section). meologue's
 *   `matchLabel` is sigil-marked and always active (./rules.ts), so it
 *   recognises `@home` as a token regardless — correctly, by its own
 *   design — but the corpus carries no Todoist-side evidence to check
 *   that recognition against, in either direction. Nothing here is
 *   falsifiable for labels; excluding the kind says so honestly instead
 *   of asserting on a comparison that doesn't exist.
 * - **`reminder`**: the auto-reminder chip Todoist shows next to any
 *   time-bearing match ("Add reminder(s): At time of task") is a
 *   *side-effect* of the date/time match already being checked below,
 *   never its own `natural-language-match` span or its own `matchId`.
 *   meologue's `!reminder` sigil is a different, unrelated marker
 *   (./rules.ts's `matchReminder`) with nothing in this corpus to compare
 *   it against either.
 * - **`uncompletable`** (`* `) and **`description`** (`//`): both are
 *   meologue-only markers (issue #170) with no Todoist equivalent at all
 *   — there is no row in this corpus where either one could be
 *   falsified.
 */
const COMPARABLE_KINDS = new Set<QuickAddToken["kind"]>([
  "date",
  "time",
  "recurrence",
  "priority",
  "project",
  "deadline",
]);

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `YYYY-MM-DD` -> Todoist's own `data-match-id` date format: `D MMM`, or `D MMM YYYY` once the year isn't the capture year (every corpus example agrees on this — a same-year date never carries a year, a rolled-forward one always does). */
function todoistDate(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  // biome-ignore lint/style/noNonNullAssertion: a YYYY-MM-DD-prefixed string always yields three numeric parts
  const base = `${day} ${MONTH_ABBR[month! - 1]}`;
  return year === REF_YEAR ? base : `${base} ${year}`;
}

function todoistDateTime(isoDate: string, time: string): string {
  return `${todoistDate(isoDate)} ${time}`;
}

/**
 * A `time` token carries no date of its own — same rule
 * ../parse-quick-add.ts's `mergeDateAndTime` already applies ("a lone
 * time token with no date token attaches to *today*"), reused here
 * rather than re-derived, since it's the one place this parser commits to
 * what a bare time means.
 */
function resolvedValueOf(token: QuickAddToken): string {
  switch (token.kind) {
    case "date":
      return todoistDate(token.date);
    case "time":
      return todoistDateTime(NOW, token.time);
    case "deadline":
      return todoistDate(token.deadline);
    case "priority":
      // Todoist's matchId is the *UI* priority level (`p1` -> `"1"`), not
      // ../task-types.ts's stored/inverted value `token.priority` already
      // holds — uiPriorityOf undoes that inversion for the comparison.
      return String(uiPriorityOf(token.priority));
    case "project":
      // Todoist's matchId for a project match is its own opaque internal
      // id (e.g. `6hXCXCVp3c4xvpgH`) — meologue has no such id and never
      // will from this parser alone, so it isn't reproducible or
      // falsifiable here. What *is* falsifiable is the name: checkRow
      // compares this against the matched text with its `#` stripped,
      // never against `matchId`.
      return token.name;
    case "recurrence":
      // parseQuickAdd flags a recurrence phrase but never resolves one
      // (./types.ts's QuickAddToken: the "recurrence" variant carries no
      // field beyond the shared start/end/raw) — resolving a phrase to
      // Todoist's canonical form or a next occurrence is
      // ../recurrence/'s job, a module this parser only ever asks "would
      // you accept this" (./date-rules.ts's matchRecurrencePhrase doc
      // comment) and never calls for a value. So a recurrence row is
      // checked on span text alone, below — this branch is never reached
      // for one.
      return token.raw;
    default:
      throw new Error(`unexpected comparable kind ${token.kind}`);
  }
}

interface RowCheck {
  ok: boolean;
  reasons: string[];
}

/**
 * Claims every expected match against exactly one comparable actual
 * token with the identical span text, then checks that claim's resolved
 * value; any expected match nothing claims, and any comparable actual
 * token nothing claimed, is reported by name. Matching by text rather
 * than by kind or position is deliberate — kind is meologue's own
 * vocabulary, not Todoist's, and start/end offsets are never something
 * the corpus recorded.
 */
function checkRow(row: CorpusRow): RowCheck {
  const result = parseQuickAdd(row.input, { now: NOW });
  const actual = result.tokens.filter((t) => COMPARABLE_KINDS.has(t.kind));
  const claimed = new Set<number>();
  const reasons: string[] = [];

  for (const match of row.matches) {
    const idx = actual.findIndex((t, i) => !claimed.has(i) && t.raw === match.text);
    if (idx === -1) {
      reasons.push(`no comparable token matched "${match.text}"`);
      continue;
    }
    claimed.add(idx);
    // biome-ignore lint/style/noNonNullAssertion: idx came from findIndex succeeding above
    const token = actual[idx]!;
    if (token.kind === "recurrence") {
      continue; // No resolved value to check — see resolvedValueOf's own case.
    }
    const expected = token.kind === "project" ? match.text.slice(1) : match.matchId;
    const resolved = resolvedValueOf(token);
    if (resolved !== expected) {
      reasons.push(
        `"${match.text}" resolved to ${JSON.stringify(resolved)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }

  actual.forEach((token, i) => {
    if (!claimed.has(i)) {
      reasons.push(`unexpected comparable match "${token.raw}" (${token.kind})`);
    }
  });

  return { ok: reasons.length === 0, reasons };
}

/**
 * Rows this parser doesn't satisfy yet, grouped by why — each group names
 * the ticket expected to flip it, or says plainly that none exists yet.
 * **This list may only shrink.** The guard test below fails the moment a
 * listed row starts passing, which is the signal to delete it from here,
 * never to leave it in place "just in case."
 *
 * A handful of these groups look like natural fits for one of the ticket
 * bodies below but aren't actually named in that ticket's own acceptance
 * criteria — flagged inline rather than assumed, since silently folding
 * an unlisted row into a ticket's scope is how a later PR "flips" this
 * fixture without its acceptance criteria ever having promised it.
 */
const PENDING: ReadonlyArray<{ reason: string; inputs: readonly string[] }> = [
  {
    reason:
      "#377 — {deadline} braces are Pro-gated in Todoist (no match at all); meologue still resolves one",
    inputs: ["{24 sept}"],
  },
  {
    reason:
      "no ticket filed yet — 'end of month' reads like #366's territory but isn't in its acceptance criteria (its abbreviations 'eom'/'eow'/'end of week' are correctly unmatched on both sides — Todoist doesn't recognise them either — so only the full phrase is pending)",
    inputs: ["end of month"],
  },
  {
    reason:
      "no ticket filed yet — hyphen/ISO/dot numeric date forms; #366 only names the two-part slash form's day-month-order bug, not these forms' absence",
    inputs: ["24-09", "2026-09-24", "24.9.2026"],
  },
  {
    reason:
      "no ticket filed yet — bare 'yesterday' isn't in englishQuickAddLanguage.relativeDays at all",
    inputs: ["yesterday"],
  },
  {
    reason:
      "no ticket filed yet — matchArithmeticDate requires a numeral (\\d+); the spelled-out form isn't recognised",
    inputs: ["in three days"],
  },
  {
    reason:
      "no ticket filed yet — 'N days from now' (word order reversed from 'in N days') isn't a recognised phrasing",
    inputs: ["3 days from now"],
  },
  {
    reason:
      "no ticket filed yet — QuickAddLanguage.arithmeticUnits has no hour/minute unit at all, and even adding one would need a time-of-day-bearing `now` (see the roll-forward group below) to resolve 'in an hour' to a clock time",
    inputs: ["in an hour", "in 30 min"],
  },
  {
    reason:
      "no ticket filed yet — 'Today's' should fail the same exact-token test 'todays' does (both fail in Todoist); meologue's \\b boundary treats the apostrophe as a separator and matches anyway",
    inputs: ["Today's standup"],
  },
  {
    reason:
      "no ticket filed yet — Todoist's matched span swallows adjacent punctuation/quotes; meologue's word-boundary match stops at the bare word",
    inputs: ["Call mom today.", "Call mom today,", 'Call mom "today"'],
  },
  {
    reason:
      "no ticket filed yet — Todoist merges an adjacent date+time (or recurrence+time) phrase into one match; meologue always keeps them as separate tokens",
    inputs: [
      "today at 5pm",
      "tomorrow morning",
      "mon 9am",
      "every day starting next monday",
      "Buy milk tomorrow at 5pm every week p2",
    ],
  },
  {
    reason:
      "no ticket filed yet — QuickAddOptions.now is date-only (LocalDayKey), so a fuzzy/explicit time can never roll to tomorrow the way Todoist does once that time-of-day has already passed today",
    inputs: ["noon", "midnight", "morning"],
  },
  {
    reason:
      "no ticket filed yet — fuzzyTimes table gaps independent of the roll-forward issue above: 'evening' is defined as 18:00 (Todoist: 19:00), and 'tonight' isn't in the table at all",
    inputs: ["evening", "tonight"],
  },
  {
    reason:
      "no ticket filed yet — a bare hour with no am/pm marker ('at 5') isn't recognised at all",
    inputs: ["at 5"],
  },
  {
    reason: "no ticket filed yet — '!!N' as an alternate priority syntax isn't implemented",
    inputs: ["!!1"],
  },
  {
    reason:
      "no ticket filed yet — contradicts D1's clone standard on the record: pushIfValidCalendarDate (./date-rules.ts) deliberately refuses a date that rolls into a different month after a year-bump (29 Feb in a non-leap year), where Todoist gracefully rolls it to 1 Mar",
    inputs: ["29 feb"],
  },
];

const PENDING_INPUTS = new Set(PENDING.flatMap((group) => group.inputs));

// Every pending input has to be a real row — catches a typo in the list
// above pointing at nothing, which would otherwise just silently match 0 rows.
describe("pending list sanity", () => {
  const corpusInputs = new Set(CORPUS.map((row) => row.input));
  it("every PENDING input names a row that exists in the corpus", () => {
    const unknown = [...PENDING_INPUTS].filter((input) => !corpusInputs.has(input));
    expect(unknown).toEqual([]);
  });
});

describe("detection corpus — passing rows", () => {
  for (const row of CORPUS) {
    if (PENDING_INPUTS.has(row.input)) {
      it.todo(`${JSON.stringify(row.input)} (pending — see PENDING list)`);
      continue;
    }
    it(JSON.stringify(row.input), () => {
      const { ok, reasons } = checkRow(row);
      expect(ok, reasons.join("; ")).toBe(true);
    });
  }
});

// The other half of "this list may only shrink": a pending row that
// starts passing has to fail *this* test, not slide by unnoticed under
// `it.todo`'s own always-skipped status.
describe("detection corpus — pending rows stay pending", () => {
  it("no PENDING row has started passing", () => {
    const startedPassing = PENDING.flatMap((group) =>
      group.inputs.filter((input) => {
        // biome-ignore lint/style/noNonNullAssertion: pending-list sanity above already confirms every PENDING input names a real row
        const row = CORPUS.find((r) => r.input === input)!;
        return checkRow(row).ok;
      }),
    );
    expect(
      startedPassing,
      startedPassing.length > 0
        ? `these PENDING rows now pass — remove them from PENDING and let them run as ordinary tests: ${startedPassing.join(", ")}`
        : undefined,
    ).toEqual([]);
  });
});
