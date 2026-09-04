/**
 * Todo's Filter grammar (issue #185, ADR 0058) — the types the tokenizer
 * (./tokenizer.ts), the parser (./parser.ts) and the evaluator
 * (./evaluate.ts) all share. Platform-free, like every other type in this
 * directory: nothing here reads a clock, a store, or the DOM.
 *
 * The grammar itself, in one place since no other file states it end to
 * end: `and` (`&`), `or` (`|`), `not` (`!`), grouping (`(` `)`), and a
 * comma to separate one query into several named result lists —
 * criterion 2's own wording, verbatim. A predicate is one of: a flag
 * (`today`, `tomorrow`, `overdue`, `undated`, `recurring`, `subtask`), a
 * priority (`p1`-`p4`), a Project (`#Name`, or `##Name` for the Project
 * *and everything nested under it* — criterion 3's "a Project with
 * everything under it"), a Section (`/Name`), a Label (`@Name`), or a
 * dated/deadlined comparison (`date:2026-09-10`, `date<2026-09-10`,
 * `date>2026-09-10`, and the identical three spellings for `deadline`).
 * ./parser.ts's own header comment has the full worked grammar and
 * ./evaluate.ts's has the full reasoning for `date`/`deadline` staying
 * two separate predicate kinds while `today`/`tomorrow`/`overdue` fold
 * them into one "what's due" question (criterion 4).
 *
 * **Criterion 5, in the type system.** `FilterNode`'s `and`/`or` variants
 * exist, but nothing in ./parser.ts ever *builds* one by silently
 * resolving `a & b | c`'s precedence — parsing a mixed, unparenthesised
 * chain is a `FilterParseError`, not a node. Every `and`/`or` node this
 * module ever produces came from a chain of the *same* operator, or from
 * an explicit `(...)` a reader wrote themselves. See ADR 0058's own
 * Decision section for why this is the deliberate reading of criterion
 * 5 ("requires explicit grouping rather than relying on an unstated
 * precedence") rather than picking one precedence and living with it.
 */

/** A half-open `[start, end)` span in the original query text, UTF-16 code units — the identical shape ../quick-add/types.ts's `QuickAddSpan` already uses, for the identical reason: a caller (the query editor's live highlight, or a "point at the offending text" error) never re-finds a span by searching the string a second time. */
export interface FilterQuerySpan {
  start: number;
  end: number;
}

/**
 * Criterion 6: "a query that cannot be parsed says so plainly." Thrown by
 * every stage of parsing that finds text it cannot make sense of, always
 * carrying the span of the text at fault (or, when nothing was typed at
 * all, `[0, 0]`) so a caller — the query editor (apps/web) — can underline
 * or point at exactly where the problem is, not just report that there
 * is one.
 */
export class FilterParseError extends Error {
  readonly span: FilterQuerySpan;

  constructor(message: string, span: FilterQuerySpan) {
    super(message);
    this.name = "FilterParseError";
    this.span = span;
  }
}

/** Every flag this grammar recognises with no argument — CONTEXT.md's "the usual flags for undated, overdue, repeating, and sub-task," plus `today`/`tomorrow`, the two calendar-relative flags "asking what is due" (criterion 4) resolves through the same Date-or-Deadline rule ./evaluate.ts's own header comment states. */
export type FilterFlag = "today" | "tomorrow" | "overdue" | "undated" | "recurring" | "subtask";

/** A UI priority level, 1-4 (p1 most urgent) — the same p1-p4 naming ../quick-add/types.ts's own `priority` token and ../task-types.ts's `uiPriorityOf` use, never the inverted 1-4 stored representation. */
export type FilterPriorityLevel = 1 | 2 | 3 | 4;

/** `on` for `field:value`, `before` for `field<value`, `after` for `field>value`. */
export type FilterDateComparison = "on" | "before" | "after";

/**
 * One node of a parsed query's expression tree. `and`/`or`/`not` are the
 * only recursive shapes; every other kind is a leaf predicate matched
 * directly against one Task (./evaluate.ts's `matchesNode`).
 */
export type FilterNode =
  | { kind: "and"; left: FilterNode; right: FilterNode }
  | { kind: "or"; left: FilterNode; right: FilterNode }
  | { kind: "not"; operand: FilterNode }
  | { kind: "flag"; flag: FilterFlag }
  | { kind: "priority"; level: FilterPriorityLevel }
  /** `#Name` (`includeDescendants: false`) or `##Name` (`true`, criterion 3's "a Project with everything under it"). `name` is matched case-and-diacritic-insensitively (../task-search.ts's `normalize`, reused rather than reimplemented) against every live Project sharing that name — Project names are never unique (../project-fields.ts's own comment), so more than one Project can match. */
  | { kind: "project"; name: string; includeDescendants: boolean }
  /** `/Name` — matched the identical way `project` above is, against every live Section sharing that name across every Project (a Section's own name is unique only within its Project, never globally). */
  | { kind: "section"; name: string }
  /** `@Name` — matched the identical way `project`/`section` above are, against every live Label sharing that name. */
  | { kind: "label"; name: string }
  /** `date:`/`date<`/`date>`/`deadline:`/`deadline<`/`deadline>` — names ONE field explicitly (criterion 3), unlike the `flag` variants above that fold both fields together (criterion 4) — see ./evaluate.ts's own header comment for why these two are deliberately different rules, not two spellings of the same one. `value` is a bare `YYYY-MM-DD`, this grammar's only date literal (no relative phrases — see ./parser.ts's own header comment for why). */
  | { kind: "due"; field: "date" | "deadline"; op: FilterDateComparison; value: string };

/** One comma-separated segment of a query, alongside the exact source text that produced it — criterion 2's "several result lists," each one a full expression tree of its own. `label` is the segment's own trimmed source text (`"today"`, `"#Work & p1"`) — the same "no invented name" choice a real Todoist makes for its own comma-separated columns, rather than this grammar inventing per-list titles nothing asked for. */
export interface FilterResultList {
  label: string;
  expr: FilterNode;
}

/** What ./parser.ts's `parseFilterQuery` returns for a query that parsed cleanly: one `FilterResultList` per comma-separated segment, in the order they were typed. Always at least one — an empty or whitespace-only query is a `FilterParseError`, not an empty array (see parser.ts's own comment on why "nothing typed" is refused rather than treated as "matches everything"). */
export interface ParsedFilterQuery {
  lists: FilterResultList[];
}
