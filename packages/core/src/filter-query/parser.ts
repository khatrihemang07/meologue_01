import { type FilterToken, tokenizeFilterQuery } from "./tokenizer";
import {
  type FilterDateComparison,
  type FilterFlag,
  type FilterNode,
  FilterParseError,
  type FilterResultList,
  type ParsedFilterQuery,
} from "./types";

/**
 * The recursive-descent parser behind Todo's Filter grammar (issue #185,
 * ADR 0058). Turns the token stream ./tokenizer.ts produces into a
 * `ParsedFilterQuery` or throws a `FilterParseError` pointing at exactly
 * the text that defeated it (criterion 6: "a query that cannot be parsed
 * says so plainly").
 *
 * **The grammar, precisely:**
 *
 * ```
 * query      := list (',' list)*
 * list       := chain
 * chain      := unary ( ('&' | '|') unary )*      -- see "criterion 5" below
 * unary      := '!' unary | primary
 * primary    := '(' chain ')' | atom
 * ```
 *
 * `atom` is whatever ./tokenizer.ts handed back as one opaque token;
 * `classifyAtom` below is what turns its text into a `FilterNode` leaf —
 * a flag, a priority, a `#Project`/`##Project`, a `/Section`, a `@Label`,
 * or a `date`/`deadline` comparison — or throws if it matches none of
 * them.
 *
 * **Criterion 5: mixing `&` and `|` is refused, not resolved.** `chain`
 * above reads as ordinary left-associative precedence climbing, but
 * `parseChain` tracks which operator the *current* chain started with
 * and throws the moment a different one appears at the same nesting
 * level — never silently building an `and`/`or` tree out of a mix ADR
 * 0058 explains most real users could not correctly predict the meaning
 * of. Parenthesising either side starts a fresh `chain` (a new call to
 * `parseChain`, via `primary`'s `'(' chain ')'` production) with no
 * memory of the operator outside it, so `(a & b) | c` and `a & (b | c)`
 * both parse — the mixing is only ever refused *within* one
 * unparenthesised level, exactly where a reader would otherwise have to
 * guess which operator binds tighter.
 *
 * **No relative or natural-language dates.** `date`/`deadline`
 * comparisons take a bare `YYYY-MM-DD` literal only — no `next monday`,
 * no `in 3 days`. This is a deliberate, narrower scope than
 * ../quick-add/'s own date rules: quick-add's whole job is guessing what
 * a reader meant from natural language typed into a single free-text
 * field, at the cost of the false-positive risk its own header comment
 * spends a paragraph justifying (`QuickAddOptions.smartDates`). A saved
 * Filter is the opposite kind of artifact — written once, matched
 * against different Tasks forever after — so a literal, unambiguous date
 * is the right trade here even though it asks a bit more of whoever
 * types the query, and it keeps this parser from importing quick-add's
 * natural-language machinery into a grammar with a completely different
 * risk profile (this ticket's own brief is explicit that the two must
 * stay separate parsers).
 */

const FLAG_ATOMS = new Set(["today", "tomorrow", "overdue", "undated", "recurring", "subtask"]);
const PRIORITY_ATOMS: Record<string, 1 | 2 | 3 | 4> = { p1: 1, p2: 2, p3: 3, p4: 4 };
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// No `\s*` around the field name or the operator: `date`/`deadline` open
// with a letter, not one of ./tokenizer.ts's four name sigils, so the
// tokenizer has already committed to stopping this atom at the first
// whitespace by the time this pattern ever sees it — `date:2026-09-10`
// only, never `date : 2026-09-10` (tokenizer.ts's own header comment has
// the full reasoning for why a bare word can't span a space).
const DATE_FIELD_PATTERN = /^(date|deadline)(:|<|>)(.+)$/i;

class Cursor {
  private readonly tokens: FilterToken[];
  private position = 0;

  constructor(tokens: FilterToken[]) {
    this.tokens = tokens;
  }

  peek(): FilterToken {
    // biome-ignore lint/style/noNonNullAssertion: tokenizeFilterQuery always appends a trailing `eof`, so `position` never runs past the array's end.
    return this.tokens[this.position]!;
  }

  advance(): FilterToken {
    const token = this.peek();
    if (token.kind !== "eof") {
      this.position++;
    }
    return token;
  }
}

/** Parses `input` into a `ParsedFilterQuery`, or throws `FilterParseError`. */
export function parseFilterQuery(input: string): ParsedFilterQuery {
  if (input.trim() === "") {
    throw new FilterParseError(
      "This Filter has no query yet — try a flag like today or overdue, a #Project, or a @Label.",
      { start: 0, end: 0 },
    );
  }

  const cursor = new Cursor(tokenizeFilterQuery(input));
  const lists: FilterResultList[] = [];

  while (true) {
    const listStart = cursor.peek();
    const expr = parseChain(cursor);
    const listEnd = previousEnd(cursor);
    lists.push({ label: input.slice(listStart.start, listEnd).trim(), expr });

    const next = cursor.peek();
    if (next.kind === "comma") {
      cursor.advance();
      continue;
    }
    if (next.kind === "eof") {
      break;
    }
    // A second predicate sitting right after one that already finished a
    // full chain, with no `&`/`|` between them — `today p1`, or `today
    // !subtask` — is a different mistake than a bare stray token, and
    // gets its own message naming the actual fix rather than the generic
    // "expected a comma or the end" ADR 0058 would otherwise show for it.
    if (next.kind === "atom" || next.kind === "not" || next.kind === "lparen") {
      throw new FilterParseError(
        `"${input.slice(listStart.start, listEnd).trim()}" and what follows need an operator between them — try "&" (and) or "|" (or).`,
        { start: next.start, end: next.end },
      );
    }
    throw unexpectedTokenError(next, "',' to start another list, or the end of the query");
  }

  return { lists };
}

// The end offset of whatever token was most recently consumed — used to
// slice a list's own source text out of `input` without the parser
// threading a running "end" value through every production by hand.
// Safe because `parseChain` never leaves a token half-consumed: by the
// time it returns, `cursor` sits exactly on the token *after* the
// expression it just built.
function previousEnd(cursor: Cursor): number {
  // `cursor.peek()` is the *next* unconsumed token; the list's own text
  // ends where that token begins, since ./tokenizer.ts already trimmed
  // whitespace out of every token's own span.
  return cursor.peek().start;
}

// `chain := unary ( ('&' | '|') unary )*`, refusing a mix of `&` and `|`
// within one call — see this module's own header comment ("criterion 5")
// for the full reasoning. A fresh call (from `primary`'s `'(' chain ')'`)
// starts a fresh, independent `sawOperator`, which is what lets
// parenthesising either side of a mix resolve it.
function parseChain(cursor: Cursor): FilterNode {
  let left = parseUnary(cursor);
  let sawOperator: "and" | "or" | null = null;

  while (true) {
    const token = cursor.peek();
    if (token.kind !== "and" && token.kind !== "or") {
      break;
    }
    if (sawOperator !== null && sawOperator !== token.kind) {
      const other = sawOperator === "and" ? "&" : "|";
      const mine = token.kind === "and" ? "&" : "|";
      throw new FilterParseError(
        `Combining "${other}" and "${mine}" needs parentheses to say which grouping you mean — try "(a ${other} b) ${mine} c" or "a ${other} (b ${mine} c)".`,
        { start: token.start, end: token.end },
      );
    }
    sawOperator = token.kind;
    cursor.advance();
    const right = parseUnary(cursor);
    left = { kind: sawOperator, left, right };
  }

  return left;
}

// `unary := '!' unary | primary`
function parseUnary(cursor: Cursor): FilterNode {
  const token = cursor.peek();
  if (token.kind === "not") {
    cursor.advance();
    return { kind: "not", operand: parseUnary(cursor) };
  }
  return parsePrimary(cursor);
}

// `primary := '(' chain ')' | atom`
function parsePrimary(cursor: Cursor): FilterNode {
  const token = cursor.peek();

  if (token.kind === "lparen") {
    cursor.advance();
    const inner = parseChain(cursor);
    const closing = cursor.peek();
    if (closing.kind !== "rparen") {
      throw new FilterParseError(`This "(" is missing its closing ")".`, {
        start: token.start,
        end: token.end,
      });
    }
    cursor.advance();
    return inner;
  }

  if (token.kind === "atom") {
    cursor.advance();
    return classifyAtom(token);
  }

  if (token.kind === "eof") {
    throw new FilterParseError("Expected a Project, Label, date, priority or flag here.", {
      start: token.start,
      end: token.end,
    });
  }

  throw unexpectedTokenError(token, "a Project, Label, date, priority or flag");
}

function unexpectedTokenError(token: FilterToken, expected: string): FilterParseError {
  const found = token.kind === "eof" ? "the end of the query" : `"${token.raw}"`;
  return new FilterParseError(`Expected ${expected}, found ${found}.`, {
    start: token.start,
    end: token.end,
  });
}

// Turns one atom token's raw text into a leaf FilterNode, or throws. Every
// branch below reflects one line of criterion 3's own list: a flag, a
// Priority, a Project (with or without its descendants), a Section, a
// Label, or a date/deadline comparison.
function classifyAtom(token: FilterToken): FilterNode {
  const raw = token.raw;
  const lower = raw.toLowerCase();

  if (FLAG_ATOMS.has(lower)) {
    return { kind: "flag", flag: lower as FilterFlag };
  }
  const priorityLevel = PRIORITY_ATOMS[lower];
  if (priorityLevel !== undefined) {
    return { kind: "priority", level: priorityLevel };
  }

  if (raw.startsWith("##")) {
    return {
      kind: "project",
      name: requireName(raw.slice(2), token, "##"),
      includeDescendants: true,
    };
  }
  if (raw.startsWith("#")) {
    return {
      kind: "project",
      name: requireName(raw.slice(1), token, "#"),
      includeDescendants: false,
    };
  }
  if (raw.startsWith("/")) {
    return { kind: "section", name: requireName(raw.slice(1), token, "/") };
  }
  if (raw.startsWith("@")) {
    return { kind: "label", name: requireName(raw.slice(1), token, "@") };
  }

  const dateMatch = DATE_FIELD_PATTERN.exec(raw);
  if (dateMatch !== null) {
    // biome-ignore lint/style/noNonNullAssertion: DATE_FIELD_PATTERN's first two groups are mandatory, non-optional captures.
    const field = dateMatch[1]!.toLowerCase() as "date" | "deadline";
    // biome-ignore lint/style/noNonNullAssertion: see above.
    const opChar = dateMatch[2]!;
    // biome-ignore lint/style/noNonNullAssertion: the third group is `.*`, always present (possibly empty).
    const value = dateMatch[3]!.trim();
    if (!ISO_DATE_PATTERN.test(value)) {
      throw new FilterParseError(
        `"${raw}" needs a date in YYYY-MM-DD form, like "${field}:2026-09-10".`,
        { start: token.start, end: token.end },
      );
    }
    const op: FilterDateComparison = opChar === ":" ? "on" : opChar === "<" ? "before" : "after";
    return { kind: "due", field, op, value };
  }

  throw new FilterParseError(
    `"${raw}" isn't something this grammar recognises. Try a flag (today, overdue, undated, recurring, subtask), a priority (p1-p4), #Project, ##Project (with its sub-Projects), /Section, @Label, or date:YYYY-MM-DD / deadline:YYYY-MM-DD.`,
    { start: token.start, end: token.end },
  );
}

function requireName(name: string, token: FilterToken, sigil: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new FilterParseError(`Name something after "${sigil}" — e.g. "${sigil}Work".`, {
      start: token.start,
      end: token.end,
    });
  }
  return trimmed;
}
