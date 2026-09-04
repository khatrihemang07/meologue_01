/**
 * A record of something that happened to a Task, a Comment, a Project or
 * a Section (issue #184, CONTEXT.md's Event entry, ADR 0056) — Todo's own
 * activity log. A third kind of root noun beside Entry and Task (ADR
 * 0047's move made a fifth time, after Project/Section/Label/Comment),
 * but a structurally different one: every other root noun in this
 * codebase is *mutable* (ADR 0028's compacted change log — one row per
 * id, overwritten in place, `seq` reassigned on every write). An Event is
 * not. It is written once, by the act it records, and never touched
 * again — there is no `edit()`, no `remove()`, and therefore no
 * `deletedAt` for either of those to set. See ./event-store.ts's own
 * header comment for what that costs this store (nothing) and what it
 * saves (the `is distinct from` replay guard every mutable store needs).
 *
 * **Stamped with the acting Device's own clock, never the time it
 * reaches a Server.** This is ADR 0056's entire reason for existing, and
 * it's worth restating here because it's the one property a future
 * "cleanup" is likeliest to "fix": the reference implementation this app
 * tracks parity against holds its own activity log on its server and
 * stamps each row when it *arrives* there, which silently rewrites an
 * offline action's own time to whenever the Device that recorded it next
 * had a connection. Measured directly against a real one: an action
 * performed offline at 23:24 was logged at 23:25, the moment the Device
 * reconnected. That is wrong here twice over — Sync is opt-in (ADR
 * 0011), so a Device with no Server URL would have no log at all if the
 * log lived there; and work done offline would read as having happened
 * whenever the network came back rather than when it was actually done.
 * `occurredAt` is `createdAt`'s own precedent (../types.ts's Entry,
 * ../task-types.ts's Task) applied a third time: every other timestamp
 * this app records that means "when something happened" already trusts
 * the Device that was there, never a server's clock.
 */
export type Event = {
  id: string;
  deviceId: string;
  eventType: EventType;
  objectType: ObjectType;
  /**
   * The id of the thing this Event is directly about — a Task's own id
   * when `objectType` is `"task"`, a Comment's own id when `"comment"`,
   * and so on. Never the Task a Comment belongs to — see `taskId` below
   * for that.
   */
  objectId: string;
  /**
   * The Task this Event concerns, for the per-Task surface
   * (CONTEXT.md's Todo entry: "a Task shows its own history"). Equal to
   * `objectId` when `objectType` is `"task"`; the parent Task's id when
   * `objectType` is `"comment"` (a Comment is never shown without the
   * Task it belongs to); `null` for a `"project"`/`"section"` Event,
   * which has no Task of its own.
   */
  taskId: string | null;
  /**
   * The Project this Event happened in, **snapshotted at the moment it
   * was recorded** — drives the per-Project surface. Deliberately not
   * "whichever Project this Task currently lives in": a Task completed
   * while filed in Project A, later moved to Project B, must keep its
   * completion Event under Project A's own history — it happened there,
   * and a Task's later move must not rewrite where a past Event is read
   * from. `null` for Inbox, or for an Event with no Project context at
   * all (a top-level Task move out of every Project, say).
   */
  projectId: string | null;
  /**
   * The acting Device's own clock — see this type's own header comment.
   * Never the server's arrival time. This is the *only* timestamp an
   * Event carries: unlike every other root noun here, there is no
   * separate `createdAt` standing for "when this row was written" —
   * that would name the identical instant on the Device that recorded
   * the Event, and a meaningless one (this Device's own receive time,
   * not a fact about the Event) on a Device that received it over Sync.
   */
  occurredAt: string;
  /**
   * Whatever this specific `eventType`/`objectType` pair needs to say
   * about what changed — `{ content, lastContent }` for a rename,
   * `{ date, lastDate }` for a reschedule. Present or absent per field is
   * a render-time decision about whether to say "you set the date" or
   * "you changed the date" (issue #184's own acceptance criterion) — this
   * store makes no such decision itself, it only carries whatever the
   * caller recorded. `null` for an Event that needs to say nothing beyond
   * its own `eventType`/`objectType` (a plain "added" with nothing worth
   * diffing).
   */
  extra: Record<string, unknown> | null;
  seq: number | null;
  syncedAt: string | null;
};

/**
 * The reference implementation's own vocabulary, copied exactly rather
 * than invented fresh — issue #184's own brief names each of these as the
 * taxonomy to match. `"deleted"` covers a Task, a Comment, a Project or a
 * Section being removed; `"moved"` covers a Task's Project, Section or
 * parent changing (extra says which).
 */
export type EventType =
  | "added"
  | "deleted"
  | "updated"
  | "archived"
  | "unarchived"
  | "completed"
  | "uncompleted"
  | "moved";

/**
 * The reference's own object vocabulary — deliberately **no `"label"`**:
 * a Label change is a `task:updated` Event carrying the Label in its
 * `extra`, never its own object type (issue #184's own brief states this
 * explicitly, matching the reference exactly rather than the more regular
 * "every root noun gets an object type" shape this codebase's other five
 * streams might suggest).
 */
export type ObjectType = "task" | "comment" | "project" | "section";
