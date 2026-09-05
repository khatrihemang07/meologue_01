/**
 * A second root noun, not an Entry with fields (ADR 0047). A Task that
 * began life as a checkbox in an Entry and a Task created directly in
 * Todo are the same kind of thing afterward — nothing here records which
 * way it arrived.
 *
 * Deliberately carries no collaboration column — no `responsibleUid`, no
 * `workspaceId`, no role, no `isShared`. This is a refusal, not an
 * omission: meologue is one person's journal and one person's task list,
 * and a dormant column doesn't sit here for free while it waits for a
 * feature nobody has designed — it's schema every future migration and
 * every store method has to keep explaining the absence of use for
 * (../sqlite/schema.ts's own comment on `entries` names the same trap
 * under ADR 0007, before ADR 0028 gave it a real use).
 *
 * Date, deadline and priority (issue #169) are on the type
 * below, and so, since issue #171, are `projectId`, `sectionId` and
 * `parentId` — sequenced behind their own migration (version 9,
 * ../sqlite/migrations/index.ts) rather than folded into an earlier one,
 * so each migration's blast radius stays the one thing it's actually
 * adding.
 */
export type Task = {
  id: string;
  deviceId: string;
  /** The Task's text. The Task owns it (ADR 0048) — an Entry's cached label is never authoritative. */
  content: string;
  /**
   * When this Task was completed, or null while it is active. A timestamp
   * rather than a boolean because completion has a *time*: #175's Digest
   * reports what was completed in a Period, and a boolean would have to
   * grow one later.
   */
  completedAt: string | null;
  /** Fractional index — see order-key.ts. Sorts lexicographically; ties break on id. */
  orderKey: string;
  /**
   * A second, independent fractional index (issue #182, ADR 0050 reused
   * rather than reinvented — see that ADR's own amendment) — the Today
   * view's own manual order, kept apart from `orderKey` above so dragging
   * a Task in Today does not silently reorder it inside its Project too.
   * Real Todoist keeps the identical split on disk: `child_order`
   * (position within a Project or Section) and `day_order` (position
   * within Today) as two independent fields on the same row, and this
   * follows that precedent deliberately rather than inventing a
   * meologue-specific shape for it.
   *
   * Required, like every field on this type (Task.priority's own doc
   * comment states the rule this follows): "nothing chosen in Today yet"
   * is not an absence this type lets a caller omit, it is a concrete
   * starting position — see task-fields.ts's withDefaultDayOrder for what
   * that starting position is.
   *
   * Carried on the wire as `day_order`, alongside `order_key`, in the
   * same protocol bump that added the four new entity streams (issue
   * #182) — a Today drag reaches a Device's other Devices the same way
   * dragging a Task in a Project already does. See mapping.ts's
   * `toWireTaskInput`/`fromWireTaskOutput`.
   */
  dayOrder: string;
  createdAt: string;
  /**
   * Issue #196: when this Task's row was last actually changed — every
   * setter below that clears `seq`/`syncedAt` to mark itself pending also
   * stamps this (see, e.g., TaskStore.rename's own doc comment).
   * Backfilled to `createdAt` for a pre-#196 row
   * (../sqlite/migrations/0014_updated_at.sql), deliberately: `created_at`
   * is stable and identical on every Device holding the same row
   * (`server/src/sync.rs`'s `insert_tasks` never reassigns it), so two
   * Devices sharing a pre-existing history converge on the same backfilled
   * value instead of a race between whichever Device migrated last. Exists
   * for Merge (issue #199) to read; Sync's own conflict rule is unchanged
   * (ADR 0028: row-level last-writer-wins by Server arrival order) and
   * does not consult this field.
   */
  updatedAt: string;
  seq: number | null;
  syncedAt: string | null;
  /** Tombstone (ADR 0028's rule, applied to Tasks). */
  deletedAt: string | null;
  /**
   * When the user plans to do the Task (CONTEXT.md's Date entry) — drives
   * Today, recurrence and reminders. `null` until the user gives it one: a Task
   * created in Todo starts undated, exactly as Todoist's own Inbox is a
   * capture bucket rather than a forced scheduling step. Either
   * `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM` (timed).
   *
   * Deliberately **floating**: no `Z`, no offset, ever. A Task set for 9am
   * is 9am wherever the Device reading it happens to be — this is a
   * *different encoding* from `createdAt` above, which is a real UTC
   * instant, and the mismatch is not an oversight. `createdAt` records
   * when something actually happened, once, on one Device's clock, and has
   * to compare correctly against every other Device's `createdAt` values
   * regardless of time zone. `date` records a plan, re-read on whatever
   * Device the user happens to be looking at it from — fixing it to a
   * zone would mean a Task planned for "9am" silently reads as a different
   * wall-clock hour on a Device in another zone, which is a coordination
   * feature this single-user app has no use for (see task-fields.ts).
   */
  date: string | null;
  /**
   * The hard cutoff (CONTEXT.md's Deadline entry) — `YYYY-MM-DD` only,
   * never a time, never a recurrence, independent of `date`: a Task may
   * carry a date, a deadline, both, or neither. task-fields.ts's
   * assertValidDeadline is the one place that refuses a deadline carrying
   * a time; every store method that writes this field calls through it
   * rather than re-checking the shape itself.
   */
  deadline: string | null;
  /**
   * 1-4, where 4 is the most urgent — inverted against the UI's p1-p4
   * naming, exactly as Todoist's own API is (CONTEXT.md's Priority entry).
   * 1 is the default and means "no priority" (UI p4): a Task *conceptually*
   * always carries a priority — "no priority" is a real level, not an
   * absence of one — so this is a plain `number`, never nullable. Use
   * uiPriorityOf/storedPriorityOf below to cross the inversion — never
   * open-code `5 - priority` at a call site, since that's exactly the kind
   * of thing a later edit silently reverses.
   *
   * These four fields (`date` through `priority`), like every field above
   * them, are **required** — nullable where the concept genuinely admits
   * absence, but never `?`-optional. That is ../types.ts's own rule for
   * `Entry.deletedAt`, `seq` and `syncedAt`, and it holds here for the
   * identical reason: "every caller that builds an Entry must say
   * explicitly whether it's live or removed, rather than an omitted field
   * silently defaulting to one or the other."
   *
   * It was briefly tempting to mark them optional so that a Task literal
   * written before issue #169 kept compiling untouched. That is the exact
   * convenience the rule above refuses, and it costs the thing this
   * ticket's own acceptance criterion turns on: "a Task created in Todo
   * starts undated" is a *decision*, and it belongs stated at the one call
   * site that creates a Task (apps/web's `addTask`), not hidden in a
   * defaulting helper that quietly fills in whatever a caller forgot. A
   * store still normalises on write, but that is a safety net for data
   * arriving over Sync, not a licence for local callers to stay vague.
   */
  priority: number;
  /**
   * The Labels (../label-types.ts) attached to this Task, as an ordered
   * array of Label ids — CONTEXT.md's Label entry ("a name the user
   * attaches to a Task, freely, across Projects"), issue #170. Required,
   * like every field above it, never `?`-optional: "no Labels" is `[]`,
   * a real and common state, not an absence this type should let a
   * caller omit and have silently default (Task.priority's own doc
   * comment makes the identical argument for why "no priority" is a
   * concrete level rather than a missing key).
   *
   * **Why an array on the Task's own row, and not a `task_labels` join
   * table — the obvious relational design for a many-to-many
   * relationship.** Three constraints this codebase already lives under
   * make the join table the wrong choice here, not merely a less tidy
   * one:
   *
   * 1. *The migrator has no transactions*
   *    (../sqlite/migrator.ts's own header comment explains why:
   *    Tauri's connection pool can hand `BEGIN` and the next statement to
   *    different connections). A join table split across two tables
   *    means writing a Task's Labels is two non-atomic statements — the
   *    Task's own row, then a batch of join rows — with no rollback if
   *    the process dies between them. A single JSON column on the Task's
   *    own row is one statement, so there's no window where a crash
   *    leaves the two halves of "this Task's Labels" disagreeing with
   *    each other.
   * 2. *Sync is row-level last-write-wins on whole rows* (ADR 0028): two
   *    Devices that each change a Task while offline converge to
   *    whichever row's `seq` was reassigned most recently, no per-field
   *    merge. A join table has no "whole row" for a Task's Labels to be
   *    — it's N independent rows, each with its own conflict outcome —
   *    so an offline label change and an offline content edit on the
   *    same Task, synced from two different Devices, could converge to a
   *    content edit that kept the *old* Labels or a Label change that
   *    reverted unrelated content, depending on arrival order per table.
   *    A JSON column folds into the Task's own row, so it converges with
   *    everything else on that row under the identical, already-relied-
   *    upon rule: whichever version of the whole Task arrived last wins,
   *    consistently, for every field including this one.
   * 3. *A Task travels as one row over the wire* (TaskStore's own
   *    upsert()/pending() contract, ../task-store.ts): the moment Labels
   *    get a Sync stream of their own, a join-table design means a Task
   *    and its label associations are two independent streams that can
   *    arrive out of order relative to each other, and a receiving
   *    Device has no way to know it's seen a consistent snapshot of
   *    both. A Task carrying its own `labelIds` needs nothing extra to
   *    stay consistent: whichever version of the Task row arrived last
   *    already has the right answer baked in.
   *
   * A second-order benefit, not the deciding one: array order is
   * preserved for free, so "the order Labels were added in" needs no
   * extra column the way a join table would need one to avoid an
   * arbitrary row order.
   *
   * The cost accepted knowingly: a `labelId` here can go dangling if the
   * Label it names is later removed (../label-store.ts's remove() does
   * not reach across stores to clean this up either — see its own doc
   * comment). That is deliberate, not an oversight: cleaning it up would
   * need a cross-store write with the identical non-atomicity problem
   * this design exists to avoid, for a case a reading layer can already
   * handle safely by treating an id with no matching live Label as
   * "filter it out" rather than an error.
   */
  labelIds: string[];
  /**
   * The literal recurrence rule the user typed — `"every 3 months"`,
   * `"every! monday"` — or `null` for a Task that doesn't repeat
   * (CONTEXT.md's Recurrence entry, issue #170's recurrence engine,
   * ../recurrence/). The string is the truth and `date` is a consequence
   * of it, never the other way round: ../recurrence/'s
   * nextOccurrenceAfterCompletion is a pure function of this string plus
   * a reference date, re-run fresh on every completion
   * (../task-store.ts's advanceRecurring), rather than a schedule
   * computed once when the rule was typed and then just incremented. The
   * very first `date` a recurring Task carries is a separate question —
   * ../recurrence/'s firstOccurrence, called once when the rule is typed
   * (issue #191) — but the same "the string is the truth" discipline
   * applies to it too: both functions re-derive `date` from `dateString`
   * rather than caching a schedule. That is the identical principle this project already
   * holds for an Entry's body, arrived at independently — see
   * ../recurrence/recurrence.ts's own module doc comment for the worked
   * example (a yearly task completed eighteen months late) that a
   * "compute once, increment forever" design would get wrong.
   *
   * **Required and nullable, like every field above it.** It shipped
   * `?`-optional for one round, on the reasoning that making it required
   * would force an edit to `apps/web`'s `addTask` — a file the half of
   * #170 that added this field was scoped away from. That is a fact about
   * how the work was divided, not a fact about the field, and a type is
   * the wrong place to record a scope boundary: the boundary dissolves
   * when the two halves land together, while the weakened type would have
   * outlived it. The rule ../types.ts states for `Entry.deletedAt` holds
   * here unchanged — every caller says explicitly rather than letting an
   * omission default silently — and `date`/`deadline`/
   * `priority`/`labelIds` above all obey it.
   *
   * ../task-fields.ts's withDefaultDateString still normalises a missing
   * value to `null` on every write, exactly as withDefaultSchedulingFields
   * does for the fields above: that is the safety net for a Task arriving
   * over Sync from a Device on an older build, whose JSON genuinely has no
   * such key, not a licence for a local caller to stay vague.
   */
  dateString: string | null;
  /**
   * The Project (../project-types.ts) this Task lives in, or `null` for
   * Inbox — CONTEXT.md's Inbox entry: "Inbox is not a container the way a
   * Project is — it names the absence of one." There is no sentinel id for
   * Inbox to point at; `null` *is* Inbox, the identical "absence, not a
   * value" encoding this field's neighbours below use for "no parent"/"no
   * Section." Required, like every field above it and for the identical
   * reason (Task.priority's own doc comment): a Task literal that omits
   * this key is a caller declining to say where the Task lives, not a
   * Task that lives nowhere in particular.
   *
   * Moving a Task between Projects is TaskStore.setProject
   * (../task-store.ts), which also clears `sectionId` back to `null` —
   * see that method's own doc comment for why a Section from the old
   * Project can't validly survive the move.
   */
  projectId: string | null;
  /**
   * The Section (../project-types.ts) this Task sits in, or `null` for
   * "no Section" — CONTEXT.md's Section entry: "A Task sits in at most one
   * Section." Meaningful only alongside a non-null `projectId`: Inbox has
   * no Sections (Section.projectId is required, never Inbox), but this
   * store does not itself enforce that a Task's `sectionId` and
   * `projectId` agree with each other — see TaskStore.setProject's own
   * doc comment for what it does instead, and ../label-types.ts's
   * `labelIds` doc comment for the general "a dangling or inconsistent
   * cross-reference is an accepted, transient state, not something this
   * store reaches across tables to enforce" reasoning this follows.
   * Required and nullable, like every field above it.
   */
  sectionId: string | null;
  /**
   * The Task this one is a sub-task of, or `null` for a top-level Task
   * (CONTEXT.md's Sub-task entry: "A Task whose parent is another Task").
   * Nesting is capped at four levels, enforced by TaskStore.setParent
   * (../task-store.ts) walking the target parent's own ancestor chain
   * before writing — not by this field's type, which cannot express a
   * rule that spans rows, and not by a caller being trusted to count
   * levels itself (CLAUDE.md's brief: "make it a property of the store
   * that a test can prove"). Required and nullable, like every field
   * above it.
   *
   * A sub-task is a full Task in every other respect — CONTEXT.md is
   * explicit — so nothing about `date`, `deadline`, `priority`,
   * `labelIds`, `dateString` or any other field above changes meaning
   * once a Task carries a non-null `parentId`. The one behaviour that
   * *does* cross the parent/child boundary is completion:
   * TaskStore.complete's own doc comment explains why completing a parent
   * cascades to its active sub-tasks and completing every sub-task never
   * cascades back up.
   */
  parentId: string | null;
  /**
   * The Task's own words about itself, beyond its `content` — Markdown,
   * rendered by the identical renderer an Entry's body already uses
   * (issue #180, apps/web's `entryProse`/inline-markdown.ts — this
   * package holds no rendering code of its own for either an Entry or a
   * Task, so there is nothing here to duplicate). `null` until the user
   * gives it one, the same "nothing chosen yet" state every attribute
   * above defaults to (Task.dateString's own doc comment states the
   * identical rule): a Task created in Todo, or promoted from a
   * checkbox, starts with no Description.
   *
   * Required and nullable, like every field above it, for the identical
   * reason (Task.priority's own doc comment): a caller states explicitly
   * that a Task has no Description rather than an omitted key silently
   * defaulting one way or the other.
   *
   * Deliberately **not** an Entry, never enters History, Export's day
   * files, or Digest grounding — CONTEXT.md's History entry is emphatic
   * that History is what the user actually wrote, and a Task's own words
   * about itself are Todo's, not History's (issue #180).
   */
  description: string | null;
};

/**
 * The one named place the UI-priority/stored-priority inversion lives
 * (see Task.priority's own doc comment for why the inversion exists at
 * all). Both directions are `5 - x` — the mapping is its own inverse — but
 * two named functions exist anyway rather than one call site writing
 * `5 - x` twice: a reader sees which direction is meant without having to
 * work it out from context, and a search for "uiPriority" or
 * "storedPriority" finds every call site instead of every arithmetic
 * expression that happens to subtract from five.
 */
export function uiPriorityOf(storedPriority: number): number {
  return 5 - storedPriority;
}

/** The inverse of uiPriorityOf — see its doc comment. */
export function storedPriorityOf(uiPriority: number): number {
  return 5 - uiPriority;
}
