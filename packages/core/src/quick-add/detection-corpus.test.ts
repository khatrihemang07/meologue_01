import { describe, expect, it } from "vitest";
import { uiPriorityOf } from "../task-types";
import { dateTimeKey } from "../test-support/day-key-fixture";
import { addDays } from "./date-math";
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
 * in this file. Issue #383 pins it to a single *instant*, not just a day
 * — `13:06 IST`, derived (not guessed) from the two rows whose own
 * matchId only makes sense at that exact minute: `"in 30 min"` ->
 * `13:36` implies `now + 30min = 13:36`, and `"in an hour"` -> `14:06`
 * implies `now + 60min = 14:06` — both independently solve to `13:06`,
 * which is why this is a derivation, not a guess: two unrelated rows
 * agreeing on the identical instant is not a coincidence a wrong guess
 * could produce. (The header's own "~13:36–14:18" is the outer range
 * across the *whole* 117-row session, not a claim that every individual
 * row was captured inside it — the two time-arithmetic rows were
 * evidently among the first, just ahead of that range's stated start.)
 * Every other time-of-day row is consistent with this instant too:
 * `noon`/`midnight`/`morning` (12:00/00:00/09:00, all before 13:06) all
 * roll to tomorrow; `evening`/`tonight` (19:00/22:00, both after 13:06)
 * stay today; `at 5` (05:00, before 13:06) rolls to tomorrow.
 */
const NOW = dateTimeKey("2026-09-19T13:06"); // Saturday.
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
 * A `time` token carries no date of its own — resolving what a bare time
 * means is ../parse-quick-add.ts's `mergeDateAndTime`'s job, not
 * re-derived by *calling* that function here (which would only prove the
 * production code agrees with itself), but recomputed independently
 * against the identical rule issue #383 gives it: a time already past
 * `NOW`'s own time-of-day means tomorrow, strict less-than, matching
 * `mergeDateAndTime`'s own choice of boundary.
 */
function resolvedValueOf(token: QuickAddToken): string {
  switch (token.kind) {
    case "date":
      // Issue #383: `matchArithmeticDate`'s hour/minute loop ("in an
      // hour", "in 30 min") produces a `date` token that already carries
      // a time-of-day suffix (`YYYY-MM-DDTHH:MM`, longer than a bare
      // `YYYY-MM-DD`) — `todoistDate` alone would silently drop it.
      return token.date.length > 10
        ? todoistDateTime(token.date.slice(0, 10), token.date.slice(11, 16))
        : todoistDate(token.date);
    case "time": {
      const nowDay = NOW.slice(0, 10);
      const nowTime = NOW.slice(11, 16);
      const day = token.time < nowTime ? addDays(nowDay, 1) : nowDay;
      return todoistDateTime(day, token.time);
    }
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
// Issue #388: the capture account's own real Project/Label list, per this
// file's own header comment ("zero pre-existing labels/projects beyond
// Inbox") — supplying it (rather than leaving `matchProject`/`matchLabel`
// on their permissive default) is what makes the two `#Inbox` rows below
// actually exercise the new exact-match path, instead of silently passing
// against the old "any word after `#` counts" behaviour forever. Checked
// against `detection-corpus.json` directly: "Inbox" is the only Project
// name that ever appears (`grep '"#'`), and no Label sigil row is
// compared at all (`COMPARABLE_KINDS` excludes `"label"` — this file's own
// comment on why), so `labelNames: []` has no row's outcome riding on it;
// it's supplied anyway for the same "the account had none" honesty.
const CORPUS_PROJECT_NAMES: readonly string[] = ["Inbox"];
const CORPUS_LABEL_NAMES: readonly string[] = [];

function checkRow(row: CorpusRow): RowCheck {
  const result = parseQuickAdd(row.input, {
    now: NOW,
    projectNames: CORPUS_PROJECT_NAMES,
    labelNames: CORPUS_LABEL_NAMES,
  });
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
// Issue #384 resolved every row this list used to carry (the apostrophe
// boundary, swallowed punctuation, and merged date+time/recurrence+time
// groups) — kept as an empty array, not deleted, so a future PENDING
// group has somewhere to land and the "no PENDING row has started
// passing" guard test below still has a (vacuously true) list to check.
const PENDING: ReadonlyArray<{ reason: string; inputs: readonly string[] }> = [];

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
