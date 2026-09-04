# 0058: A Filter query refuses an unstated and/or precedence, and prefers a Task's Date over its Deadline when asking what is due

## Status

Accepted. Builds on [0047](0047-a-task-is-a-second-root-noun.md) (a Task is a second root noun) and
[0050](0050-tasks-are-ordered-by-fractional-index.md)'s neighbour
[0049](0049-todo-is-the-first-destination-with-internal-navigation.md), which is where Filter's own
route lives inside Todo's internal navigation. Reuses, rather than duplicates, `task-views.ts`'s
`today()` union rule (issue #169) and its `effectiveDateKey` primary sort key — see *Decision*
below for exactly how the two relate. Does not touch
[0028](0028-entries-and-tasks-both-carry-seq-syncedat-deletedat.md)'s Sync scaffolding rule beyond
applying it a sixth time to a new table; see *Consequences* for why this ticket stops there rather
than opening a Filter Sync stream.

## Context

CONTEXT.md has defined Filter since Todo was designed — "a saved query over Tasks" — and issue
#185 is the first ticket to build one. The acceptance criteria ask for a real grammar: `and`, `or`,
`not`, grouping, a comma to separate one query into several named result lists, and predicates
naming a Project (with or without everything nested under it), a Section, a Label, a Priority,
dates and deadlines, and the flags Todoist itself calls undated, overdue, recurring and sub-task.

Two of those criteria are not merely "implement the obvious thing":

- **Criterion 5** asks that mixing `and` with `or` in one expression require explicit grouping
  rather than relying on an unstated precedence. This is a real design question with two opposite
  answers, not one: pick a precedence (the way most programming languages resolve `&&` against
  `||`) and document it, or refuse the mix outright and require the reader to say what they mean.
  A real Todoist plainly does not commit to a legible answer here — its own support material has
  historically warned that combining `&` and `|` without parentheses in the same query gives
  unpredictable results, which is a hedge, not a rule a reader can hold in their head. Copying that
  hedge would ship the exact ambiguity issue #185 was asked to avoid.
- **Criterion 4** asks that "what is due" consider both a Date and a Deadline, "preferring the Date
  when a Task has both." `task-views.ts`'s `today()` (issue #169) already answers a related-looking
  question — which Tasks belong in Today — but by a different rule: an inclusive *union* of "Date
  matches" and "Deadline matches," either one enough to qualify. A union has no preference between
  its two conditions; "prefer the Date" only means something once a single, preferred value is
  chosen ahead of evaluating anything else. The two rules were at risk of being conflated, since
  both start from the same two fields.

## Decision

**A Filter's grammar refuses an unparenthesised mix of `&` (and) and `|` (or) as a parse error,
naming both groupings the reader probably meant.** The parser (`filter-query/parser.ts`) climbs a
chain of same-operator terms exactly like ordinary precedence climbing, but tracks which operator
the current, unparenthesised chain started with; the moment a different one appears at the same
nesting level, parsing stops with `Combining "&" and "|" needs parentheses to say which grouping
you mean — try "(a & b) | c" or "a & (b | c)"`, pointing at the offending operator's own span.
Parenthesising either side starts a fresh chain with no memory of what surrounded it, so both
suggested groupings actually parse. This is deliberately **not** "and binds tighter than or," "or
binds tighter than and," or "left to right" — every one of those is a real, defensible choice a
reader would have to look up once and remember forever, and this ticket's own brief is explicit
that inventing one and hoping it matches the reader's intuition is the trap to avoid, not a
convenience to add.

**Criterion 6 rides on the identical mechanism.** Every stage of parsing — the tokenizer never
throws; the parser does, for a mixed chain, an unmatched paren, an unrecognised atom, or an empty
query — raises one `FilterParseError` carrying a message and a `[start, end)` span into the
original text (mirroring `quick-add/types.ts`'s own span shape). `apps/web`'s query editor
(`filter-view.tsx`) shows that message plainly and disables Save whenever it's thrown, for both a
Filter being created and one being edited: there is no state in this design where a query fails to
parse and Save stays reachable, unlike the reference implementation's own defect (silently shows
nothing, leaves Save enabled) this ticket was asked not to copy.

**"What is due" (`today`, `tomorrow`, `overdue`) reads a single, Date-preferring value; naming a
field explicitly (`date:`, `deadline:`) reads only that field.** `filter-query/evaluate.ts` reuses
`task-views.ts`'s own `effectiveDateKey` — `task.date ?? task.deadline` — for the three due-flags,
which is exactly "the Date if there is one, the Deadline only if there isn't." `date:`/`deadline:`
comparisons never fold the two fields together at all: a query that names one field explicitly
(criterion 3's "dates and deadlines" as two nameable things) gets an answer about that field alone,
regardless of what the other field says.

**The one case this deliberately disagrees with `today()` on:** a Task with a *future* Date and a
*passed* Deadline. `today()`'s union puts this Task in `overdue`, because its Deadline half fires
independently of the Date. A Filter's `overdue` flag does not, because `effectiveDateKey` has
already picked the Date (one exists) before "before/on/after today" is even asked — the Task reads
as due on its future Date, not overdue. This is not an oversight reconciled after the fact:
`evaluate.test.ts` pins the case by name (`"a future Date with a passed Deadline is NOT overdue,
unlike Today's own union rule"`), and `evaluate.ts`'s own header comment explains why "preferring
the Date" cannot mean the same thing as `today()`'s "either field is enough."

## Alternatives considered

- **A conventional precedence — `and` binds tighter than `or`, the common convention among
  languages that have both.** Rejected for the reason given above: criterion 5 asks for an explicit
  refusal, not a documented default, and a Filter is written once and matched forever after — a
  reader who gets the implicit precedence wrong finds out only when the Filter quietly returns the
  wrong Tasks, not when they write it.
- **Left-to-right evaluation, ignoring conventional precedence entirely.** Same rejection: still an
  implicit rule invisible at the point the query is typed, just a different one to memorise.
- **A single Date-or-Deadline union for every dated predicate, matching `today()` exactly, so
  "due" and Today never disagree.** Rejected on the ticket's own text: criterion 4 says "preferring
  the Date," and a union has no preference to state — implementing this alternative would have
  answered a question issue #185 did not ask, at the cost of contradicting its own acceptance
  criterion in the one case where the two fields disagree.
- **Extending `quick-add/`'s existing parser to also handle Filter syntax**, since a natural-language
  parser for Task capture already exists in this codebase. Rejected per this ticket's own brief:
  Filter's grammar is structured (operators, precedence rules, grouping) where quick-add's is
  heuristic (natural language guessed from free text, with a real false-positive risk its own
  header comment spends a paragraph justifying) — a shared parser would mean either weakening
  Filter's own unambiguity guarantees to fit quick-add's shape, or bolting a second, incompatible
  mode onto a module that already has one job. A relative date phrase (`next monday`) is
  consequently out of scope for a `date:`/`deadline:` predicate too — see `parser.ts`'s own header
  comment for that narrower call, made for the identical "different grammar, different risk
  profile" reason.

## Consequences

A Filter's own storage is local-only and deliberately sync-ready, not sync-wired: `filter-store.ts`
carries the full `seq`/`syncedAt`/`deletedAt`/`pending()`/`getCursor()`/`setCursor()`/
`catchUpRowShapeEpoch()` scaffolding `label-store.ts` shipped ahead of Labels' own Sync stream
(issue #170, wired up by issue #182), for the identical reason: retrofitting that scaffolding after
the fact needs a real migration plus a backfill of every row minted before it existed, while
shipping it now costs nothing. Nothing in issue #185's acceptance criteria asks a Filter to reach
another Device, so wiring an eighth Sync stream — a wire-protocol bump, a `ROW_SHAPE_EPOCH` entry,
a server table — stays a future ticket's own acceptance bar to clear, exactly as issue #182 was for
Labels.

The grammar itself is intentionally narrower than a real Todoist's in two places, both named
explicitly rather than left to be rediscovered: no relative date phrases (`date:` and `deadline:`
take a bare `YYYY-MM-DD` only), and no quoting for a Project/Section/Label name containing one of
the six reserved characters (`&`, `|`, `!`, `,`, `(`, `)`) — a name like `Home & Garden` cannot be
named by this grammar at all. Both are real, accepted gaps rather than defects: nothing in issue
#185's acceptance criteria asks for either, and a real Todoist's own docs are silent on the second
gap too.

A future ticket that wants a Filter Sync stream, or a richer date grammar, inherits this ADR's own
refuse-rather-than-guess posture: extending the grammar to accept a new predicate is free (one more
branch in `classifyAtom`), but loosening the mixed-operator refusal into any implicit precedence
would reopen exactly the ambiguity this ADR exists to close, and should not be done without a new
ADR of its own.
