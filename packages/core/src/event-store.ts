import type { Event } from "./event-types";

/**
 * The Event-shaped sibling of CommentStore (./comment-store.ts) — mirrors
 * its shape closely, with the members an *immutable* stream doesn't need
 * removed rather than left as unreachable no-ops:
 *
 * - **No `edit()`.** An Event carries no field this store ever changes
 *   after it's written (../event-types.ts's own header comment).
 * - **No `remove()`, and so no tombstone.** ADR 0028's `deletedAt`
 *   exists to let a *mutable* row travel from "something" to "nothing"
 *   through Sync — there is no "nothing" state an Event can be in, so
 *   there is nothing for a tombstone to represent. Deleting a Task
 *   records a `task:deleted` Event; it does not delete that Event.
 * - **No `get()` by id.** Nothing in this app opens a single Event on its
 *   own — every reader wants a list (this Task's history, this Project's,
 *   or everything), never one row in isolation.
 *
 * What's left is `record()` (this store's one write door — see its own
 * doc comment for why it isn't `upsert()` the way every mutable store's
 * local-and-Sync write path is) plus three read shapes (global, per-Task,
 * per-Project) and the ordinary `pending()`/cursor pair every Sync stream
 * carries.
 */
export interface EventStore {
  /**
   * Every Event across the whole app, newest first (`occurredAt`
   * descending, ties broken by id descending — the same "time-ordered
   * id, so an ascending tie-break would misorder a same-millisecond
   * pair" reasoning EntryStore.list's own doc comment gives). The view
   * across everything (issue #184's own acceptance criterion) reads this
   * directly; a Task or Project's own history narrows it via
   * `listByTask`/`listByProject` below instead of filtering this
   * client-side, so a personal log that eventually holds thousands of
   * rows doesn't cost every narrower view a full table scan.
   */
  list(): Promise<Event[]>;
  /**
   * One Task's own history, newest first, same order as list() — every
   * Event whose `taskId` names this Task, which already includes Events
   * about Comments made against it (../event-types.ts's `taskId` doc
   * comment).
   */
  listByTask(taskId: string): Promise<Event[]>;
  /**
   * One Project's own history, newest first — every Event whose
   * `projectId` names this Project, snapshotted at record time
   * (../event-types.ts's `projectId` doc comment: a Task's later move
   * out of this Project does not retroactively remove its earlier
   * Events from here). `projectId: null` reads Inbox's own history, the
   * identical "`null` names the absence of a Project, not a row" rule
   * ../project-types.ts's own header comment states for a Task.
   */
  listByProject(projectId: string | null): Promise<Event[]>;
  /**
   * Writes a new Event. Named `record()` rather than `upsert()` — every
   * mutable store's write door doubles as both "create locally" and
   * "apply what Sync pulled back," because a mutable row can legitimately
   * arrive from either direction carrying the *same* meaning ("this is
   * the current state"). An Event has no such duality on the local side:
   * this Device only ever calls `record()` once, at the moment the act
   * it describes happens, and never again for that same `id`. `upsert()`
   * still exists below, doing only the second half — applying Events
   * this Device didn't originate, arriving from Sync — because that half
   * genuinely is bulk, deduplicated-by-id merge, the same shape every
   * other stream's Sync-facing `upsert()` already is.
   */
  record(event: Event): Promise<void>;
  /**
   * Sync's pull-side write path — applies Events arriving over the wire,
   * bulk, like every other store's `upsert()`. **Overwrites by id**,
   * unlike `record()` above — this is not a contradiction of "an Event
   * is never rewritten": the *content* of an Event with a given id never
   * legitimately differs between two calls (an id is minted once, by
   * `record()`, and nothing in this app ever pushes a second, different
   * Event under the same one), so an overwrite is observably a no-op for
   * every row this Device didn't itself write. The one case where it is
   * **not** a no-op is exactly the one this door has to handle: the echo
   * of this Device's own pending push, arriving back with `seq` filled
   * in where it left with `seq: null`. `record()`'s own "insert if
   * absent" would silently refuse that update, leave the local row
   * permanently `pending()`, and push the same Event again on every
   * future sync tick forever. Every other mutable store's `upsert()`
   * already handles this identical "echo of my own write" case by
   * overwriting; this store needs the same behaviour for the same
   * reason, even though — unlike theirs — nothing about *why* it
   * overwrites has anything to do with last-writer-wins.
   */
  upsert(events: Event[]): Promise<void>;
  /** Events with no sequence number — exactly `seq IS NULL`, mirroring every other stream's pending(). */
  pending(): Promise<Event[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
}
