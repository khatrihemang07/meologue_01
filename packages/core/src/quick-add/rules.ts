import { storedPriorityOf } from "../task-types";
import {
  type DateRuleContext,
  isEveryBangAt,
  matchDateForms,
  matchTimeForms,
  resolveWholePhrase,
} from "./date-rules";
import type { QuickAddToken } from "./types";

/**
 * The sigil-marked rules (issue #170's Part A) — every one of these is
 * always active, regardless of `QuickAddOptions.smartDates`, because the
 * user typed an explicit marker on purpose: `#`, `/`, `@`/`%`, `p1`-`p4`,
 * `!`, `{}`, a leading `* `, `//`. See ./types.ts's
 * `QuickAddTokenKind` doc comment for why that's the line
 * `smartDates` draws, and ./date-rules.ts for the family it turns off.
 */

/** A leading `* ` — issue #170's uncompletable marker. Only recognised at the very start of the input; `* ` appearing mid-sentence is plain text (a literal asterisk), not this token. */
export function matchUncompletable(input: string): QuickAddToken[] {
  const match = /^\*[ \t]+/.exec(input);
  if (match === null) {
    return [];
  }
  return [{ kind: "uncompletable", start: 0, end: match[0].length, raw: match[0] }];
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Every substring of `input` that looks like a URL — a scheme (RFC 3986: a
 * letter, then letters/digits/`+`/`.`/`-`, then `:`) followed by `//` and a
 * run of non-whitespace characters. `https://`, `http://`, `ftp://`, and so
 * on.
 *
 * Issue #386's own finding was `matchDescription`'s `//` firing on a URL's
 * own (`Read https://example.com/post` lost everything from the `//`
 * onward as a "description," so the URL never survived in the title — #373
 * needs the same "a URL in the title stays plain text" behaviour). But the
 * identical problem exists for every OTHER sigil character a URL happens
 * to contain — most concretely, `matchSection`'s `/` fires again on that
 * same URL's own `/post`, which `matchDescription`'s old bug had been
 * masking by (wrongly) claiming the whole remainder first. `urlSpans` is
 * shared by `matchDescription` and `collectNamedMatches` (`#project`,
 * `/section`, `@label`) rather than re-derived per rule, so a URL is
 * protected from all of them the same way, not patched one at a time as
 * each collision is separately noticed.
 *
 * Deliberately NOT handled: a schemeless URL (`example.com//x`). Telling a
 * bare domain apart from ordinary text that happens to end in a dot before
 * a sigil character (an abbreviation, an ellipsis) needs a much broader
 * heuristic, and the risk of a new false positive there outweighs this one
 * edge case — see `matchDescription`'s own test for the schemeless case,
 * which documents the gap rather than silently reproducing it.
 */
function urlSpans(input: string): readonly Span[] {
  const regex = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S*/g;
  const spans: Span[] = [];
  let match: RegExpExecArray | null = regex.exec(input);
  while (match !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    match = regex.exec(input);
  }
  return spans;
}

function isInsideUrl(index: number, spans: readonly Span[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

/** `//description` — everything from the first `//` to the end of the input becomes the description text, except a `//` that's a URL's own (see `urlSpans`'s own doc comment for why, and for the one case this deliberately doesn't handle). */
export function matchDescription(input: string): QuickAddToken[] {
  const spans = urlSpans(input);
  const regex = /\/\//g;
  let match: RegExpExecArray | null = regex.exec(input);
  while (match !== null) {
    if (!isInsideUrl(match.index, spans)) {
      const start = match.index;
      return [
        {
          kind: "description",
          start,
          end: input.length,
          raw: input.slice(start),
          text: input.slice(start + 2).trim(),
        },
      ];
    }
    match = regex.exec(input);
  }
  return [];
}

const WORD_NAME_PATTERN = "[\\p{L}\\p{N}_-]+";

/** `#project` — the name is any run of letters/digits/`_`/`-`, so a project called `q1-goals` or `2026-review` both work. */
export function matchProject(input: string): QuickAddToken[] {
  return matchNamedSigil(input, "#", "project");
}

/**
 * `/section` — the lookahead on the character right after `/` excludes a
 * digit, which is what keeps this from firing on the `/` inside a
 * numeric date like `27/1/2026` (a section name starting with a digit
 * isn't a form issue #170's own examples ask for, and refusing it here
 * is what avoids the ambiguity rather than resolving it by luck of rule
 * ordering).
 */
export function matchSection(input: string): QuickAddToken[] {
  const regex = new RegExp(`\\/(?=[\\p{L}_])(${WORD_NAME_PATTERN})`, "gu");
  return collectNamedMatches(input, regex, "section");
}

/**
 * `@label` and `%label` (issue #369) — Todoist's help centre now
 * documents `%` as the label sigil, with "@ also works for now, but is
 * planned to be retired by the end of 2026." Measured in the live app:
 * both are fully equivalent today — same dropdown, same resolved label
 * id, same saved result, no deprecation hint anywhere in the UI — so both
 * are recognised here, not just the one Todoist's docs lead with. `%` was
 * deliberately retired by issue #226 in favour of `@` alone; this
 * re-add is Todoist itself reversing that call, not a return to a bug.
 */
export function matchLabel(input: string): QuickAddToken[] {
  return [...matchNamedSigil(input, "@", "label"), ...matchNamedSigil(input, "%", "label")];
}

function matchNamedSigil(input: string, sigil: string, kind: "project" | "label"): QuickAddToken[] {
  const regex = new RegExp(`${sigil}(${WORD_NAME_PATTERN})`, "gu");
  return collectNamedMatches(input, regex, kind);
}

function collectNamedMatches(
  input: string,
  regex: RegExp,
  kind: "project" | "section" | "label",
): QuickAddToken[] {
  // `urlSpans`'s own doc comment: a URL's own `/`, `#` or `@` isn't this
  // rule's sigil (issue #386, found via `matchSection`'s `/post` in a URL).
  const spans = urlSpans(input);
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    if (isInsideUrl(match.index, spans)) {
      continue;
    }
    // biome-ignore lint/style/noNonNullAssertion: the pattern's one capture group always participates when the overall match succeeds
    const name = match[1]!;
    tokens.push({
      kind,
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      name,
    });
  }
  return tokens;
}

/**
 * `p1`-`p4`, and — issue #382's own corpus row — `!!1`-`!!4` as an
 * alternate spelling of the identical priority, stored through
 * ../task-types.ts's storedPriorityOf, never open-coded (issue #170's
 * own instruction). `p1`/`!!1` is the most urgent, stored as 4.
 *
 * Pushed ahead of `matchReminder` in ../parse-quick-add.ts's own
 * candidate list (unchanged by this addition — both were already in that
 * relative order), which is what lets `!!1` win the whole three-character
 * span over `matchReminder`'s own greedy per-`!` scan: without that
 * push-order priority, `!!1` would otherwise read as two independent bare
 * `!` reminder markers with `1` left as stray text, exactly as it did
 * before this rule recognised the compound form at all.
 */
export function matchPriority(input: string): QuickAddToken[] {
  const regex = /\bp([1-4])\b|!!([1-4])\b/gi;
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    const digit = match[1] ?? match[2];
    // biome-ignore lint/style/noNonNullAssertion: one alternative's character class always captures a single digit 1-4 when the overall match succeeds
    const uiPriority = Number(digit!);
    tokens.push({
      kind: "priority",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      priority: storedPriorityOf(uiPriority),
    });
  }
  return tokens;
}

/**
 * `{deadline}` — the text inside the braces has to resolve, as a whole,
 * to one of ./date-rules.ts's date forms (`resolveWholePhrase`); braces
 * around anything else produce no token at all, rather than a deadline
 * this parser silently made up from a partial match. Always active
 * regardless of `smartDates`: the brace is the marker, and once it's
 * there the eager/non-eager distinction has nothing left to guard
 * against — see ./types.ts's `QuickAddTokenKind` doc comment.
 */
export function matchDeadline(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const regex = /\{([^}]+)\}/g;
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: `[^}]+` guarantees the capture group participates
    const phrase = match[1]!;
    const resolved = resolveWholePhrase(phrase, ctx, [matchDateForms]);
    if (resolved === null || resolved.kind !== "date") {
      continue;
    }
    tokens.push({
      kind: "deadline",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      deadline: resolved.date,
    });
  }
  return tokens;
}

/**
 * `!reminder` — `!` immediately followed by a time-of-day phrase that
 * resolves as a whole against ./date-rules.ts's time forms (explicit or
 * fuzzy). `!` with no recognisable time following it still produces a
 * token (`time: null`) rather than nothing at all: the `!` itself is the
 * marker the user typed on purpose, and a caller (the Composer, issue
 * #170's Part D) still needs to know a reminder was asked for even when
 * this parser can't pin down when. Always active regardless of
 * `smartDates`, for the identical reason `{deadline}` is. One `!` is
 * excluded on sight — `isEveryBangAt`'s own doc comment explains why
 * "every!" belongs to ./date-rules.ts's recurrence-phrase grammar
 * instead.
 */
export function matchReminder(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const tokens: QuickAddToken[] = [];
  for (const bang of input.matchAll(/!/g)) {
    if (isEveryBangAt(input, bang.index)) {
      // "every!" — ./date-rules.ts's own recurrence-phrase anchor, not
      // this `!` read as an unrelated reminder marker. See
      // `isEveryBangAt`'s own doc comment for why this exact character
      // is the one place the two grammars can collide.
      continue;
    }
    const rest = input.slice(bang.index + 1);
    // Two candidate word-counts, longest first — `at 5pm` needs both
    // words; `5pm` needs only one. A single greedy `\S+(?:\s+\S+)?`
    // regex would over-consume a *third* word ("!5pm tomorrow") into the
    // candidate phrase and fail resolveWholePhrase's exact-length check,
    // silently losing a time this parser can plainly see — trying two
    // words, then one, and stopping at the first whole-phrase match
    // avoids that rather than hoping the greedy form never overshoots.
    const words = rest.match(/^\S+(?:\s+\S+)?/)?.[0]?.split(/\s+/) ?? [];
    const [firstWord] = words;
    const candidates =
      words.length > 1 && firstWord !== undefined ? [words.join(" "), firstWord] : words;
    const resolved = candidates
      .map((phrase) => resolveWholePhrase(phrase, ctx, [matchTimeForms]))
      .find((token): token is QuickAddToken => token !== null);
    if (resolved !== undefined && resolved.kind === "time") {
      const end = bang.index + 1 + resolved.end;
      tokens.push({
        kind: "reminder",
        start: bang.index,
        end,
        raw: input.slice(bang.index, end),
        time: resolved.time,
      });
      continue;
    }
    // No recognisable time after `!` — the marker alone is still a
    // reminder token (this function's own doc comment), spanning just
    // the `!` itself so it doesn't swallow unrelated following words.
    tokens.push({ kind: "reminder", start: bang.index, end: bang.index + 1, raw: "!", time: null });
  }
  return tokens;
}
