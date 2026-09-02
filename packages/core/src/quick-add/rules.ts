import { storedPriorityOf } from "../task-types";
import {
  type DateRuleContext,
  matchDateForms,
  matchTimeForms,
  resolveWholePhrase,
} from "./date-rules";
import type { QuickAddToken } from "./types";

/**
 * The sigil-marked rules (issue #170's Part A) — every one of these is
 * always active, regardless of `QuickAddOptions.smartDates`, because the
 * user typed an explicit marker on purpose: `#`, `/`, `%`, `p1`-`p4`,
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

/** `//description` — everything from the first `//` to the end of the input becomes the description text. */
export function matchDescription(input: string): QuickAddToken[] {
  const match = /\/\/(.*)$/s.exec(input);
  if (match === null) {
    return [];
  }
  const start = match.index;
  return [
    {
      kind: "description",
      start,
      end: input.length,
      raw: match[0],
      // biome-ignore lint/style/noNonNullAssertion: the capture group is always present for a `.*` match, even on an empty string
      text: match[1]!.trim(),
    },
  ];
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

/** `%label` — `%`, never the retiring `@` (issue #170's own instruction; CONTEXT.md's Label entry). */
export function matchLabel(input: string): QuickAddToken[] {
  return matchNamedSigil(input, "%", "label");
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
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
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

/** `p1`-`p4` — stored through ../task-types.ts's storedPriorityOf, never open-coded (issue #170's own instruction). `p1` is the most urgent, stored as 4. */
export function matchPriority(input: string): QuickAddToken[] {
  const regex = /\bp([1-4])\b/gi;
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: the character class in the pattern guarantees a single digit 1-4
    const uiPriority = Number(match[1]!);
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
 * `smartDates`, for the identical reason `{deadline}` is.
 */
export function matchReminder(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const tokens: QuickAddToken[] = [];
  for (const bang of input.matchAll(/!/g)) {
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
