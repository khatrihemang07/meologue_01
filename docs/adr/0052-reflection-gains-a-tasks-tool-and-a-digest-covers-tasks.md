# 0052: Reflection gains a Tasks tool, and a Digest covers Tasks, without touching ADR 0023

## Status

Accepted. Builds on [0031](0031-reflection-is-a-loop-over-tools.md) (the tool loop this ADR's
`list_tasks` tool is registered into, unchanged in shape) and
[0047](0047-a-task-is-a-second-root-noun.md) (which forward-referenced this ADR for "Reflection's
own reach into Tasks"). Reaffirms, rather than amends, [0023](0023-reflection-is-a-fixed-three-source-fan-out.md):
that ADR's own Status already records it as superseded by 0031, and this ADR's whole argument is
that nothing about a fifth tool reopens that supersession — see Decision below. Extends
[0027](0027-digests-are-written-ahead-of-time-by-a-background-worker.md) (the Digest worker this
ADR's Task coverage runs inside, unchanged in cadence, trigger, or immutability) and
[0051](0051-sync-carries-two-entity-streams.md) (whose `HealthCapabilities::todo` this ADR is the
first real reader of). Export's own Task coverage is issue #175's other half, decided directly in
code rather than in an ADR of its own, per 0047's Consequences.

## Context

Issue #175's own framing states directly what a Digest and a journal-plus-task-list app are for
together: "what did I say I'd do about this?" is unanswerable from Entries alone once a checkbox
line has been promoted into a Task with its own due date and completion, tracked separately from
the words that first mentioned it. Before this ticket a Digest had nothing to say about that
question at all, because until issue #172 a Task didn't exist server-side — a Digest covered every
root noun the Server held, and that happened to still be a complete claim because there was only
one. A Task is now a second root noun with a Server-side table
(`server/migrations/0010_create_tasks.sql`), and CONTEXT.md's own Digest entry ("Grounded in
exactly the Entries it was written from") is a fact about a world with one root noun — this ADR's
Decision, below, is what keeps that claim true in spirit (a Digest's *prose about Entries* is still
grounded in exactly the Entries behind it) once a second kind of fact enters the same prose;
CONTEXT.md's own wording is a documentation update outside this ADR's file ownership, left for a
follow-up rather than edited here.

Two different places in this codebase need to learn Tasks exist, for two different reasons, and
this ADR is the record for both:

**Reflection** answers a Question the reader actually asked, one Question at a time, by looking at
whatever the model decides is relevant. **Digest** writes prose about a whole Period, unasked,
ahead of time, from everything the Period held. The first is a *lookup*; the second is a
*summary*. Both need to reach Tasks, but the shape each one needs is different — see Decision for
each in turn.

## Decision

### Reflection: `list_tasks`, a fifth tool, and ADR 0023's fan-out stays exactly what it is

**`list_tasks(status, query?, limit?, offset?)` joins `entries_in_range`, `search_entries`,
`similar_entries` and `read_digest` as a fifth `AgentTool`** (`harness::tools::tasks`), registered
in `reflect.rs::run_reflect_stream_inner`'s tool `Vec` unconditionally — no capability gate, no
`Option`-wrapped construction the way `similar_entries` needs one for its embed client (see
Gating, below, for why). `status` selects `active`, `completed`, or `overdue` (an active Task whose
`date` or `deadline` has already passed as of the asking Device's own local "today" —
`utc_offset_minutes`, the identical injected-offset rule ADR 0023 already established for
`entries_in_range`'s date-range argument, applied here to "what day is it" instead); `query`
optionally narrows by a word or phrase in the Task's own text. Pagination, the truncation-note
contract, and the character budget all copy `entries_in_range`'s own shape byte-for-byte — ADR
0031's ""[Showing 1-20 of 47. Use offset=21 to continue.]" ... silence is how the model knows it
has everything" rule, this tool's fourth copy rather than its first (`search_entries` and
`similar_entries` are the second and third).

**The fan-out ADR 0023 describes is not touched, and could not be even if it still existed as
code.** ADR 0031's own Consequences already settled the vocabulary this ADR relies on: the fan-out
was *retrieval* — three searches, run unconditionally for every Question, whether or not their
results were used. A tool under the loop is the opposite by construction: `AgentTool::execute`
never runs unless the model's own reply contains a `<tool_call>` naming it (`agent_loop::run`'s own
contract, unchanged by this ticket). A Question about a feeling that never mentions a task, a plan,
or something the reader said they'd do simply never produces a `<tool_call>` naming `list_tasks`,
and so spends none of its grounding budget on the to-do list — not because this ticket added a
guard, but because that is what "a tool, not a fan-out" has meant since 0031 shipped, for every
tool including this one. `server/tests/reflect.rs`'s `a_non_task_question_pulls_no_task_context`
proves this by construction rather than by inspection: a live Task with unmistakable content sits
in the database throughout a run whose scripted model never calls `list_tasks`, and that content
is asserted absent from every message sent to the model across the whole run — the only path by
which it could ever appear is a `list_tasks` tool result, so its absence is proof the tool never
ran, not merely that the final Answer didn't quote it.

**A Task is never laundered into `grounding_entry_ids`.** `ToolOutcome::entry_ids` feeds the wire's
`grounding_entry_ids`, which specifically means "an Entry appeared in a tool result this run"
(`harness::tools::mod`'s own doc comment). `list_tasks` never calls `.with_entry_ids(...)`, the
identical discipline `read_digest.rs` already established for a Digest found by that tool — a
Task's own ids travel in `ToolOutcome::details` instead, tagged `"source": "tasks"`, mirroring
`read_digest`'s `"source": "digest"` tag. This is not a new rule; it is the existing one applied to
a second kind of non-Entry content, which is exactly the generality issue #95's own ticket set out
to prove (`read_digest.rs`'s own doc comment: "if a Digest ... costs exactly one tool and nothing
else, the claim that this design scales to a new kind of data is demonstrated rather than
asserted"). This is the second data point for that claim, not a new one.

**No Project or Section name resolution.** A Task's `project_id` is a bare, unvalidated `uuid` on
this Server — Projects and Sections do not sync server-side as of this ticket (`0010_create_tasks.sql`'s
own header comment) — so `list_tasks` never renders a Project name it cannot actually look up.
This is ADR 0051's own "an unresolved reference degrades to itself, honestly" rule, applied here to
a read instead of a Sync arrival: the raw id still travels in `details` for whatever future reader
wants it, but the rendered line a model reads never claims a name this Server has no way to verify.

### Digest: completed and overdue Tasks, read once per Period, at generation time, told to write prose

**`write_digest_for` and `run_regenerate` (`digest.rs`) each fetch `DigestTasks` — completed Tasks
and overdue Tasks for the Period — and pass them into `generate_digest_body`, which appends a
short block of Task facts to the *last* chunk's own chat call.** A Digest's shape is a summary, not
a lookup, so there is no tool for the model to choose to call: the facts are simply supplied, the
same way Entries already are.

**Completed** is `completed_at` falling inside the Period's own `[from_utc, to_utc)` — the
identical half-open UTC window `select_entries` already reads for Entries, since `completed_at`
(like `created_at`) is a real instant. **Overdue** is scoped to the Period, not to "as of today": an
active Task whose `date` or `deadline` falls inside the Period's own inclusive local date range
counts once, in the Digest for the Period it slipped in, and never again in any later Period's
Digest for the same Task. The alternative — "every Task overdue as of today" — would repeat the
identical still-open Task in every Digest written from the Period it first slipped in onwards,
forever, which is exactly the scoreboard-that-never-clears the next paragraph argues against from
the other direction. "Overdue in its Period" is a fact about that stretch of time specifically,
told once, not a running tally.

**The system prompt is told, in as many words, not to turn this into a scoreboard.**
`digest_system_prompt` gains one paragraph: weave whatever is worth mentioning into the same
continuous prose, never as a separate list, heading, or count of items done and not done — "a
Digest that reports task activity as a scoreboard has stopped being a Digest." This is CONTEXT.md's
own Digest entry taken at its word: a Digest is prose about a stretch of time, and a bullet list of
`[x]`/`[ ]` is not prose about anything, it is a different genre wearing a Digest's name. The Task
facts fed to the model are themselves terse and list-shaped (`render_tasks_block`) — that is
input, not output; the instruction is what keeps the two from being confused.

**The same "invent nothing" discipline the Entries half of this prompt already carries is extended
to Tasks, in the same paragraph.** "Use only the Tasks you are actually given — invent nothing
there either — and if none are given, ... say nothing about tasks at all rather than inventing
something to say." This is the "honest grounding" half of this ticket's own acceptance criteria:
a Digest's *prose* cannot claim a completion or a slip that didn't happen, and an empty
`DigestTasks` (`render_tasks_block` returns `None`) means the model is never handed a Task section
to begin with, so it has literally nothing to embellish.

**`grounding_entry_ids` stays Entry-only; there is no `grounding_task_ids`, and this is a
deliberate choice, not an oversight.** Widening the wire shape here would mean a new `digests`
column, a `PROTOCOL_VERSION`-adjacent wire change, and a change to `digest-reader-page.tsx`'s own
rendering of what a Digest was "grounded in" — a bigger, separate decision this ticket does not
make. The honesty this ticket's acceptance criteria actually asks for — "a Digest's grounding must
still report honestly what it was written from" — is delivered a different way: `grounding_entry_ids`
continues to mean exactly what it always has (the Entries a Digest's *prose about the journal* was
written from), and the invent-nothing instruction above is what keeps the *Task* half of that same
prose equally honest, without requiring a second field to say so on the wire. A future ticket that
wants a per-Entry-style Grounding disclosure for Tasks specifically is free to add one; this ticket
does not need it to keep its own promise.

**A failed Task query degrades to `DigestTasks::default()`, never to a failed Digest.** Entries
remain this worker's primary subject (ADR 0027); a Task query erroring means only "this Digest
won't mention Tasks this time," logged at `warn`, not a reason to burn an attempt or lose an
otherwise-writable Digest over a second, unrelated table. This mirrors ADR 0023's own rule that
"any failure in extraction degrades to 'no date range, no keyword,' never to a failed Question" —
the identical shape, applied to a different failure with a different degraded state.

**Task coverage never changes *whether* a Digest gets written, only what it says once one is.**
`write_digest_for`'s existing "no Entries, no Digest" guard is untouched, and `run_regenerate`'s
identical guard stays gated on Entries alone. A Period with real Task activity but zero Entries
still produces no Digest — widening the trigger to include Task-only Periods is a separate,
bigger decision (it would mean a background worker reasoning about a second table's own
completeness independently of the first) that this ticket does not make.

### Gating

Both Server-side features are unconditionally present — `list_tasks` is always in the tool `Vec`,
and Task coverage always runs inside `generate_digest_body` — because `HealthCapabilities::todo`
(ADR 0051) is itself unconditionally `true`: "Task Sync has no model behind it and nothing that can
disable it short of the whole Server being down" (`health.rs`'s own doc comment on that field).
There is no configuration state for either feature's registration to condition on, in the identical
way `entries_in_range`/`search_entries`/`read_digest` need no gate (only `similar_entries` does,
because it alone depends on an optional embed client — a real "maybe not," which `todo` is not).
`todo`'s own doc comment already names this ADR's two features as its intended reader — "issue
#175's Digest and Reflection coverage of Tasks is what actually consults it" — and this is that
consultation: not a runtime `if capabilities.todo`, because nothing on this Server can ever make
that check return anything but true, but the acknowledgement, recorded here, that both features
exist *because* that capability's own contract holds.

**Todo itself stays ungated**, unchanged by this ticket: `chat-list.tsx`'s Todo row keeps
`capability: undefined`, exactly as ADR 0051 already decided — Todo works fully offline like
Composer, and locking it on a capability that is definitionally always true would be a strange
thing to build even if the temptation existed.

## Alternatives considered

- **Fold Task lookup into an existing tool** (e.g., `search_entries` matching Task content too, or
  a combined "search everything" tool). Rejected on the same grounds issue #94 already gave for
  keeping `search_entries` and `similar_entries` separate: a Task and an Entry fail on different
  kinds of Question, and a merged tool would hide exactly that difference from the model — it
  could no longer say "look for a Task" versus "look for what I wrote" as two distinct intents,
  which is precisely the distinction "what did I say I'd do" needs to draw against "what did I
  write about."
- **Recompute "overdue" as of the read time, at Reflection's own layer, rather than server-side.**
  Rejected: `list_tasks` already needs the asking Device's local "today" for the identical reason
  every date-sensitive tool here does (ADR 0023's injected-offset rule), so there is no independent
  layer this computation could move to without duplicating that same offset-handling logic a
  second time.
- **A `grounding_task_ids` field on the wire, mirroring `grounding_entry_ids`.** Considered for the
  Digest half specifically. Rejected for this ticket as a bigger change than the acceptance
  criteria actually require — see Decision's own paragraph on why the invent-nothing instruction
  already delivers the honesty being asked for, without a schema and wire change reaching into
  `digest-reader-page.tsx`.
- **Widen `fill_period`'s own scan to also consider Task activity when deciding which Periods need
  a Digest at all.** Rejected: Entries remain this worker's primary subject, and teaching the
  background worker to reason about completeness across two independent tables (when does a
  Task-only Period "become writable"?) is a materially bigger design question than "does an
  already-written Digest mention Tasks," which is all this ticket is scoped to answer.
- **Repeat an overdue Task in every later Digest until it is finally completed**, the naïve "as of
  today" reading of "overdue." Rejected directly in Decision, above — this is the shape that turns
  a Digest into the scoreboard CONTEXT.md's own "prose about a stretch of time" framing rules out,
  just spread across many Periods instead of one.

## Consequences

**A Digest chat call now costs slightly more tokens** — two extra queries and a short block of
facts appended to one chunk's own user message — but no extra chat call: Task coverage rides the
same single call (or, on the rare multi-chunk Period, the same last call) a Digest already made,
never a second round trip.

**A multi-chunk Digest can lose Task coverage if its own last chunk is the one issue #137 skips.**
Task facts are attached only to the final chunk's call, so a transport error or a rejected reply on
that specific chunk costs the whole Period its Task coverage along with that chunk's own Entries.
Accepted, not fixed: a real corpus essentially never reaches the chunking threshold at all
(`DIGEST_ENTRY_BUDGET_FRACTION`'s own doc comment), so this is a cost paid, if ever, in an already-rare
case, and building a second retry path for Task facts alone would be complexity spent on a
combination of two already-rare events.

**Reflection's tool count grows to five, and `render_tool_guidance`'s system prompt grows by one
more bullet accordingly** — the same "adding a tool adds its description, removing it removes it"
property issue #93 designed for, holding for a fifth tool exactly as it held for the second through
fourth.

**`server/tests/reflect.rs` and `server/src/harness/tools/tasks.rs`'s own test module are now the
two places that prove ADR 0023's supersession is durable, not merely historical** — a future sixth
tool over some further kind of data has this ticket's own tests as the worked example of what
"prove the fan-out stays untouched" looks like in practice: assert the tool's content is absent
from every message when the model never calls it, not merely that the final Answer happens not to
mention it.
