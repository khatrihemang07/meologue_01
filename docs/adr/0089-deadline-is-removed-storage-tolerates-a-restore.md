# 0089: Deadline is removed as a concept; storage tolerates a Restore reinjecting one

## Status

Accepted. Completes D12 in `.scratch/todoist-add-todo/DECISIONS.md` — issue #375 first stopped
Task ordering and classification reading `deadline` (`packages/core/src/task-views.ts`'s
`compareForToday`/`today()`/`effectiveDateKey`), issue #376 then removed every UI surface that
could set, edit, clear or display one. This ADR is the third and last step D12 named: the parser
token, the Filter predicate, and the glossary entry go too, while the storage column and its wire
mapping stay — and it is the one place the restore-tolerance invariant D12's own "Risk" paragraph
names gets written down permanently, rather than living only in a scratch file.

## Context

Deadline was a Todo-only concept: a hard, date-only cutoff independent of a Task's own Date
(CONTEXT.md's former Deadline entry). On a free Todoist account it was unreachable everywhere —
the menu item carried a gold upgrade icon, and the detail modal opened a "Try Pro for free" panel
instead of a picker. Cloning that faithfully (ADR 0088's own standard: interaction model, grammar
and resolution values, not just visible affordances) means Deadline has no place left in meologue
either, not merely a hidden one.

**Measured before committing to the removal:** both live databases were checked directly. 28 Tasks
in Production, 55 in Sandbox, **zero carrying a deadline in either.** No user data is affected by
any part of this change.

The removal proceeded in three tickets, each independently gated and tested, because the combined
blast radius — ordering, every UI surface, and the parser/grammar/glossary — was too wide to
verify as one diff:

- **#375** — `packages/core/src/task-views.ts` stopped reading `deadline` for Today's ordering,
  overdue classification and the primary sort key (`effectiveDateKey`). Left alone, on purpose:
  `tasksForDay` (History's day blocks, issue #174) still unions on `deadline` — not named in
  #375's acceptance criteria, and harmless today since nothing can set the field.
- **#376** — every UI affordance went: `TaskScheduleSheet`'s Deadline picker, `TaskCommandMenu`'s
  "Deadline…" item, the `D`/`Shift+D` keyboard shortcuts, `TaskDetailView`'s attribute pill, the
  "Due {day}" row chip, and the activity-log copy naming a Deadline change. The `onOpenSchedule`
  prop chain that existed only to reach the now-gone menu item was removed too, all the way up
  through `TaskRow`/`TaskTree`/`TaskList`/`ProjectView`/`TodayView`/`UpcomingView`.
- **This ticket (#377)** — the parser stops producing a `"deadline"` token kind at all, the
  Filter grammar's `deadline:`/`deadline<`/`deadline>` predicate is gone, and the CONTEXT.md
  glossary entry is removed, since the term no longer names anything the domain has.

## Decision

**Deadline stops being a concept this app's code can name, parse, store into from any reachable
door, or query by field name. The storage column and its wire mapping are the one deliberate
exception, and they stay unconditionally.**

Concretely:

- **The parser.** `matchDeadline` (`packages/core/src/quick-add/rules.ts`) is deleted, along with
  the `"deadline"` member of `QuickAddTokenKind` and the `deadline` field on `QuickAddResult`
  (`quick-add/types.ts`). Simply deleting the rule was not enough on its own: without it, the free
  text a `{...}` pair used to shield (`{27 Jan}`, `{tomorrow}`) became eligible for ordinary
  free-text date recognition, which is a *wider* brace behaviour than before, not a narrower one —
  measured directly against `detection-corpus.json`'s own captured row: bare `24 sept` is a real
  Todoist match, but the identical text as `{24 sept}` is not, on a Deadline-less account.
  `parseQuickAdd` (`quick-add/parse-quick-add.ts`) now masks every `{...}` span to same-length
  blanks before any rule — sigil-marked or eager — ever scans the input, reproducing the old
  blocking effect with no token, no kind and no field at all: `{24 sept}` survives into `content`
  exactly as typed, the same way any other unrecognised text already does, and the corpus row
  moves out of `detection-corpus.test.ts`'s `PENDING` list as part of this change.
- **The Filter grammar.** `deadline:`/`deadline<`/`deadline>` (`filter-query/parser.ts`'s
  `DATE_FIELD_PATTERN`) are gone; `date:`/`date<`/`date>` are the only field predicates left, and
  `FilterNode`'s `due` variant dropped its now-permanently-one-valued `field` discriminant
  entirely rather than keep it as a no-op. `matchesFlag`'s `undated` case
  (`filter-query/evaluate.ts`) simplified from `task.date === null && task.deadline === null` to
  `task.date === null` alone, the identical simplification `effectiveDateKey` already made for
  #375. **An existing saved Filter using `deadline:` does not crash the app.** Criterion 6
  ("a query that cannot be parsed says so plainly") already built the mechanism this needs:
  `deadline:2026-09-10` now falls through to the grammar's generic "isn't something this grammar
  recognises" `FilterParseError`, and `filter-view.tsx`'s own `evaluation` `useMemo` already
  catches every `FilterParseError` and renders it as the query's own error state — opening such a
  Filter shows that message in place of a match list, in place of a crash. Proven directly, not
  just argued: `filter-view.test.tsx`'s own "opens a Filter whose saved query used the removed
  deadline: predicate" case renders one and asserts the error text, not an exception.
- **The glossary.** CONTEXT.md's "Deadline" entry is removed. Two other entries that referenced
  it are corrected rather than left stale: "Upcoming" was already wrong before this ticket (it
  claimed to read "the same two independent date fields Today does," but `upcoming()`
  — `task-views.ts` — has only ever grouped by Date); "Day block" and "History" drop "or
  deadlined"/"dated or deadlined" down to "dated," matching what `tasksForDay` actually promises a
  *reader* — the dormant restore-tolerance code path stays (see below), but it is implementation,
  not domain vocabulary the glossary states its purpose is to define.
- **Storage stays, unconditionally.** `Task.deadline` (`task-types.ts`), `TaskStore.setDeadline`
  and its `assertValidDeadline` validation (`task-store.ts`, `task-fields.ts`), the sqlite column
  and migration (`sqlite/schema.ts`, `sqlite/migrations/`), and the wire mapping
  (`mapping.ts`, `generated/wire.ts`) are all untouched. `PROTOCOL_VERSION` does not change.
  Dropping the column from the wire would force a version bump and, per ADR 0057 ("a field added
  to an existing stream triggers one cursor reset"), a full re-walk of the entire Task stream on
  every device that has ever synced — real, paid-by-every-device cost for a column holding
  nothing, on data that measurably does not exist.

## The restore-tolerance invariant

**A Restore from an old backup can reinject a non-null `deadline` value into a schema that no
longer reads it anywhere reachable. No code path may assert the field is null or absent — every
removal above has to keep working correctly, without throwing, when it is not.**

This is permanent, not a migration-window concern: a backup can be arbitrarily old, and nothing
about restoring one revalidates or strips fields against the app's current feature set. Every
piece of this removal was built, and is tested, against that constraint directly rather than
merely by not asserting nullness in passing:

- `task-views.test.ts` — a Task carrying a restored `deadline` orders exactly as if it had none,
  and `today()` does not throw.
- `filter-query/evaluate.test.ts` — `undated` still matches a Task with no Date, even carrying a
  restored `deadline`, without throwing; `date:` predicates ignore a restored `deadline` value
  entirely rather than falling back to it.
- `task-schedule-sheet.test.tsx`, `task-detail-view.test.tsx`, `task-row.test.tsx` — a Task
  carrying a restored `deadline` renders every affected surface with no error and no mention of
  it (#376's own coverage, carried forward here as the same invariant).
- `task-title-commit.test.ts`, `quick-add-task.test.ts` — a typed `{...}` phrase, brace-shaped
  exactly like an old Deadline token, commits as literal text and calls no setter, on both the
  create and rename paths.

## Alternatives considered

- **Drop the storage column and bump `PROTOCOL_VERSION`.** Rejected on D12's own evidence: 0
  Tasks in either live database carry a deadline, so there is no data worth the cost of a full
  stream re-walk on every synced device (ADR 0057). The column costs nothing sitting unread.
- **Assert `deadline === null` somewhere, as a cheap sanity check that the removal "took."**
  Rejected: this is exactly the invariant this ADR forbids. A Restore can legitimately reinject a
  non-null value at any time in the future, and an assertion would turn a harmless, silently-ignored
  field into a hard failure the moment one arrives.
- **Keep `deadline:` in the Filter grammar, evaluating it against nothing (always `false`) rather
  than refusing to parse it.** Rejected: this would silently accept a query naming a field that no
  longer exists anywhere else in the app, which is a worse dishonesty than a plain parse error —
  criterion 6 already exists specifically so an unrecognised query says so, not so it quietly
  matches nothing forever.
- **Leave `tasksForDay`'s (History day blocks) `deadline` union alone entirely, including in the
  glossary.** Partially accepted: the code path stays (issue #174 is not this ticket's to touch,
  and the behaviour is dormant, not broken). Rejected for the glossary specifically — CONTEXT.md's
  own stated purpose is domain vocabulary, not implementation detail, and "Deadline" is no longer
  a concept a reader types, sees, or reasons about anywhere in the product.

## Consequences

`{24 sept}` (and any other brace-wrapped text) now leaves the braces as literal title text and
sets nothing, matching a free Todoist account exactly, including the corpus's own measured
divergence between bracketed and bare text. A saved Filter using the removed `deadline:` predicate
degrades to a visible, criterion-6-shaped error rather than breaking the page it's opened from. The
storage column, `TaskStore.setDeadline`, and the wire mapping remain exactly as they were, so a
device that synced a deadline value years ago — or a Restore that reinjects one tomorrow — is read
back correctly and silently ignored everywhere ordering, UI and Filter evaluation touch it, per the
invariant above, rather than the removal being conditional on the field actually being empty.
