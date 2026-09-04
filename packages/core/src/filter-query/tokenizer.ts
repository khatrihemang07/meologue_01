/**
 * Splits a Filter query into tokens for ./parser.ts. Deliberately dumb:
 * this stage knows about punctuation, not grammar — `&`, `|`, `!`, `,`,
 * `(` and `)` are always their own one-character token, and every other
 * run of characters (whitespace-trimmed) is a single opaque `atom`
 * token, whatever it says. Classifying an atom's text into a flag, a
 * `#Project`, a `date:2026-09-10`, or an error is ./parser.ts's job
 * (`classifyAtom`), not this one — the identical "tokenise first, then
 * ask an atom what kind of thing it wants to be" order-of-operations
 * ../quick-add/'s rules already keep for its own, differently-shaped
 * grammar.
 *
 * **Why a sigil-led atom may contain internal spaces, and a bare one may
 * not.** A Project, Section or Label name can itself contain a space
 * (`#Home Chores`), and this grammar has no quoting syntax to mark one
 * off — so an atom that opens with `#`, `##`, `/` or `@` reads
 * everything up to the next reserved character, spaces included: `#Home
 * Chores & today` tokenizes as the atom `"#Home Chores"`, then `&`, then
 * the atom `"today"`. An atom that opens any other way (a flag, a
 * priority, a `date`/`deadline` comparison) stops at the *first*
 * whitespace instead, exactly like every other single-word token in this
 * grammar — this is what lets `today p1` tokenize as **two** atoms with
 * nothing between them (a `FilterParseError` ./parser.ts raises, "these
 * need an operator") rather than as one nonsense atom `"today p1"` that
 * a whitespace-tolerant scan would otherwise produce, and it's why
 * `date:2026-09-10` must be written with no spaces around the `:`/`<`/
 * `>` — seeing that atom starts with `d`, not a sigil, this tokenizer has
 * already committed to stopping at whitespace before it ever learns the
 * word is going to turn out to be `date`.
 *
 * A Project named `Home & Garden` cannot be named by this grammar at
 * all, since its own `&` would be read as the operator — a real,
 * accepted limitation. Nothing in issue #185's acceptance criteria asks
 * for quoting, and a real Todoist has the identical gap (its own docs
 * are silent on escaping `&` inside a Project name), so this follows
 * that precedent rather than inventing one.
 */

export type FilterTokenKind = "lparen" | "rparen" | "and" | "or" | "not" | "comma" | "atom" | "eof";

// The four sigils that open a name allowed to contain internal spaces —
// see this module's own header comment for why every other atom stops at
// the first whitespace instead.
const NAME_SIGILS = new Set(["#", "/", "@"]);

export interface FilterToken {
  kind: FilterTokenKind;
  /** Trimmed for an `atom`; the single reserved character itself for every operator token; `""` for `eof`. */
  raw: string;
  start: number;
  end: number;
}

const RESERVED = new Set(["(", ")", "&", "|", "!", ","]);

const SINGLE_CHAR_KIND: Record<string, FilterTokenKind> = {
  "(": "lparen",
  ")": "rparen",
  "&": "and",
  "|": "or",
  "!": "not",
  ",": "comma",
};

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Tokenizes `input` in full — never throws; an atom's text is validated later, by the parser, against the grammar it's found in (a `not`'s operand, a group, a list). Always ends with one `eof` token, whose `start`/`end` both equal `input.length`, so a caller never has to special-case "ran out of tokens" as a separate condition from "found an eof token." */
export function tokenizeFilterQuery(input: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i] as string;
    if (isWhitespace(ch)) {
      i++;
      continue;
    }
    const kind = SINGLE_CHAR_KIND[ch];
    if (kind !== undefined) {
      tokens.push({ kind, raw: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    const nameLed = NAME_SIGILS.has(ch);
    let j = i;
    while (
      j < n &&
      !RESERVED.has(input[j] as string) &&
      (nameLed || !isWhitespace(input[j] as string))
    ) {
      j++;
    }
    const raw = input.slice(i, j);
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const leadingWhitespace = raw.length - raw.trimStart().length;
      const trailingWhitespace = raw.length - raw.trimEnd().length;
      tokens.push({
        kind: "atom",
        raw: trimmed,
        start: i + leadingWhitespace,
        end: j - trailingWhitespace,
      });
    }
    i = j;
  }
  tokens.push({ kind: "eof", raw: "", start: n, end: n });
  return tokens;
}
