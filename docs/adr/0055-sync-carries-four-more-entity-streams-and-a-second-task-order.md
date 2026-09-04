# 0055: Sync carries four more entity streams, and the Server speaks protocol 5 and 6 for one release

## Status

Accepted. Builds on [0051](0051-sync-carries-two-entity-streams.md), whose shape this ADR reuses
in full rather than re-deriving — the per-stream Cursor, the per-stream advisory-lock key, the
`is distinct from` guard across every mutable column, and the transitional protocol-version range
are all decided there, and only the specifics of applying them a second time are this ADR's own to
argue. Also settles the forward reference that ADR's own Consequences left open ("Health's `todo`
capability is reported and, for now, read by nobody but issue #175") by leaving it exactly as
found — see this ADR's own Decision for why. Depends on [0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md)
for the compacted-change-log rule every one of the four streams below reuses, and on the amendment
to [0050](0050-tasks-are-ordered-by-fractional-index.md) landing in the same release, which is why
`day_order` rides along on this exact bump rather than getting one of its own.

## Context

ADR 0051 named Projects, Sections and Labels explicitly as *not* this Server's problem yet — "issue
#172 is scoped to Tasks only" — and left a Task's own `projectId`/`sectionId`/`labelIds` as
honestly-dangling references, a state that ADR 0051's own Alternatives section already committed
to resolving without a repair step "the moment issue #173 lands Project Sync." Issue #180 gave
Comments the identical local-only scaffolding — `seq`, a Cursor, `pending()` — ahead of its own
Sync stream, on the same "build it in now, retrofit costs a migration later" reasoning ADR 0051's
Consequences state for Labels. Both debts are due at once: a Task now regularly names a Project,
Section or Label that a second Device has never heard of, and a Comment written on one Device
stays invisible everywhere else.

Whether to widen `/v1/sync` again or add a second endpoint, and whether to accept a fifth
protocol-version-shaped cost, are not open questions this time — ADR 0051 already answered both,
and for reasons that don't depend on which entity is being added. This ADR is the record of
applying that answer to four entities instead of one, not a second design.

## Decision

**Each of Projects, Sections, Labels and Comments gets its own array, its own Cursor, and its own
advisory-lock key** — `since_project_seq`/`projects`, `since_section_seq`/`sections`,
`since_label_seq`/`labels`, `since_comment_seq`/`comments` on `SyncRequest`, the paired outputs and
cursors on `SyncResponse`, and `PROJECT_SYNC_INSERT_LOCK_KEY`/`SECTION_SYNC_INSERT_LOCK_KEY`/
`LABEL_SYNC_INSERT_LOCK_KEY`/`COMMENT_SYNC_INSERT_LOCK_KEY` (`server/src/sync.rs`) alongside
`TASK_SYNC_INSERT_LOCK_KEY`. ADR 0051's own reasoning for a distinct key per stream — sharing one
would serialise an unrelated stream's push for a guarantee neither needs — holds unchanged for a
fourth and fifth and sixth table; nothing about that argument was specific to there being exactly
two streams; four more calls for four more keys, not a shared one because four felt like enough to
finally consolidate.

**Each `insert_*` upsert's `where` clause names every one of its own table's mutable columns in
its `is distinct from` chain**, mirroring `insert_tasks` field for field. This is worth restating
plainly rather than trusting it to follow from "mirror Tasks": a Section alone has five mutable
columns (`project_id`, `name`, `description`, `order_key`, `archived`) and it would be easy to
list four of them and stop, satisfied that the shape looks right. A guard missing one column does
not fail loudly — it fails by making a genuine, isolated change to that one column indistinguishable
from a no-op replay, so the `where` evaluates false and the change is silently never written at
all. `server/tests/sync.rs`'s `a_push_that_changes_only_day_order_still_reassigns_seq_and_is_not_dropped`
is the test shaped to catch exactly this, and every new stream's own replay test is the same
shape, over its own table.

**`PROJECT_STORE_METHODS`'s single Section-shaped write door gets a second one.** ADR 0051 pointed
out, for Tasks, that a Task's `projectId`/`sectionId`/`labelIds` cross entities this Server did not
yet sync, and treated that as an accepted, honest gap rather than something to patch around. Wiring
Section Sync in this ADR exposed that `ProjectStore.addSection` — the only creation door a Section
had — is a *validated* one: it refuses a twenty-first Section in the same Project
(`project-fields.ts`'s `assertSectionCapNotExceeded`), which is exactly the kind of check ADR 0051's
own Alternatives section already ruled out for a Sync pull, on the identical ground: a trusted
bulk-merge must never refuse a row another Device already committed, or the two Devices diverge
instead of converging. `ProjectStore` gains `upsertSections` — a second, unvalidated write door,
mirroring `upsertProjects` exactly — rather than routing Sync's pull through `addSection` and
either breaking convergence or quietly quadrupling the cap's reach across offline Devices.

**Unresolved Project/Section/Label cross-references degrade the same way ADR 0051 already decided
for `projectId`.** A Section naming a `project_id` this Server has never seen a Project row for
round-trips with the id intact, never rejected, never nulled — the identical rule, restated once
more here because the failure mode (a Task, or now a Section, must never vanish for naming
something Sync hasn't caught up on yet) recurs at every layer this kind of reference appears, not
because the rule itself needed rethinking.

**`HealthCapabilities.todo` (ADR 0037, ADR 0051) is left exactly as it was: unconditionally
`true`, unchanged by this ADR.** It was already the wrong shape for a per-feature answer before
this release — it reports whether this Server structurally accepts anything under Todo, not
whether any one of Tasks, Projects, Sections, Labels or Comments in particular is enabled, because
none of the five is ever conditionally configured the way `reflect`/`digest`/`embeddings` are.
Four more streams sharing that same unconditional "yes" is the correct extension of what the field
already meant, not a gap this ADR leaves open.

**`PROTOCOL_VERSION` moves from 5 to 6; `MIN_PROTOCOL_VERSION` stays at 4.** A Device on 5 has no
way to represent any of the four new streams, exactly as a Device on 4 had no way to represent a
Task — and every ability to keep syncing Entries and Tasks regardless, which is what actually
matters: Android, macOS and web still ship on three independent schedules, and a Device that has
never opened a Project picker still deserves its journal working. Raising the floor to 5 — dropping
protocol-4 support — was on the table for this release and is deliberately declined: nothing about
shipping four more streams requires it, and ADR 0051 already named that decision as its own later,
separate release rather than a side effect of the next feature to land. `run_sync` gates all four
new streams' response halves on `protocol_version >= 6`, the identical shape the Task stream's own
`>= 5` gate already takes — a Device on 4 or 5 pulls Entries and Tasks and simply receives empty
arrays for the rest, never data it has no representation for.

**`day_order` (the amendment to ADR 0050) rides on this exact bump rather than shipping local-only
and catching a bump of its own later.** A field that ships ahead of its own wire support is not
free — `packages/core/src/mapping.ts`'s `fromWireTaskOutput` needs an `existing`-fallback branch
for as long as it lasts, and every Device that set a `dayOrder` in that window has it silently
reset to whatever the wire's next echo happens to send once the field does get one. `description`
lived in exactly that window across issues #180 and this one; `day_order` does not have to, because
this bump was already being spent on Sync's wire shape regardless. `TaskInput::day_order` is
`#[serde(default)]`, the identical accommodation `SyncRequest`'s own new top-level fields get,
because a Device built before this bump — including the real protocol-5 Device this release was
verified against — sends no such key at all.

## Alternatives considered

Every alternative ADR 0051 weighed and rejected — four separate endpoints, a hard cutover with no
transitional window, one version number per stream — applies here unchanged and is not re-litigated;
nothing about going from one new stream to four changes which of those trade-offs wins. The one
choice specific to this ADR, addressed above rather than here, is whether Section Sync's pull
should reuse `addSection`'s validated door or gain its own — resolved in the Decision, not listed
as a rejected alternative, because it surfaced as a correctness bug (a Sync pull that can refuse a
row) rather than a genuine design fork.

## Consequences

**Four more `is distinct from` chains are now something a future column addition to any of these
tables has to remember to extend**, the identical maintenance burden ADR 0051 already named for
Tasks, paid four more times. Nothing here makes that burden self-enforcing; a future field still
depends on whoever adds it reading this ADR, or `insert_tasks`'s own doc comment, closely enough to
notice the pattern.

**The dual-version window is now three-wide in practice** — 4, 5 and 6 all answer `/v1/sync`
successfully, each seeing a different slice of what a fully-updated Device would. Dropping 4 (and,
later, 5) stays a deliberate, separate release exactly as ADR 0051 already decided; this ADR adds
no new pressure to do so on any particular timeline.

**A Task's own two independent orders, `order_key` and `day_order`, sync as ordinary fields on the
existing Task stream** — no fifth Task-shaped lock key, no separate Cursor for `day_order` alone,
because both live on the one row the Task stream already carries wholesale. The amendment to ADR
0050 is what argues for the column; this ADR is only responsible for the fact that it happened to
cross the wire in the same release as everything else here.
