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
 * Date, deadline, duration and priority (issue #169) are on the type
 * below. Project, section and parent are still deliberately excluded —
 * those land in issue #171 behind their own migration, sequenced apart on
 * purpose, so each migration's blast radius is the one thing it's
 * actually adding.
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
  createdAt: string;
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
   * Minutes, capped at 1440 (24 hours). Requires `date` to carry a time —
   * there's nothing to measure a length from otherwise — enforced by
   * task-fields.ts's assertValidDuration rather than by this field's type,
   * because the rule spans two fields and a type can't express that.
   */
  duration: number | null;
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
