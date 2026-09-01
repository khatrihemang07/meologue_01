import type { Task } from "./task-types";

/**
 * The Task-shaped sibling of EntryStore (./store.ts) — a second store
 * interface beside it, not a widening of it (ADR 0047: `EntryStore` is
 * Entry-specific down to its method names, `list`/`upsert`/`pending`/
 * `getCursor`/`setCursor`/`search`/`edit`/`remove`, chosen for one kind of
 * row). Both are backed by the one shared SqliteDriver a Device already
 * opens (ADR 0007) — see ./sqlite/open.ts.
 *
 * There is deliberately no `add`: a new Task is `upsert([task])`, the same
 * door Sync uses to write a Task back after a round trip, exactly as
 * useHistory's `sendEntry` builds an Entry and calls `store.upsert`. A
 * second creation path would be a second place a caller could forget to
 * set a field `upsert` already has to handle correctly for Sync anyway.
 */
export interface TaskStore {
  /**
   * Active Tasks — not completed, not tombstoned — in (orderKey, id)
   * ascending order (see ./order-key.ts's compareByOrder, which every
   * Device applies identically with no Server involved). A completed Task
   * leaves this list the moment complete() runs; it does not linger with
   * a strikethrough the way a naive "just filter in the UI" approach might
   * suggest, because listCompleted() below is the home for it instead.
   */
  list(): Promise<Task[]>;
  /**
   * Completed Tasks, newest completion first (`completedAt` descending),
   * ties broken by id descending — the same "time-ordered id, so an
   * ascending tie-break would misorder a same-millisecond pair" reasoning
   * EntryStore.list's own doc comment gives for Entries. Tombstones are
   * excluded: a deleted Task has nothing left worth showing in a
   * completed list either.
   */
  listCompleted(): Promise<Task[]>;
  /** One Task by id, or undefined if unknown or tombstoned. */
  get(id: string): Promise<Task | undefined>;
  /** Sync's write path: upsert wholesale, exactly as EntryStore.upsert does. */
  upsert(tasks: Task[]): Promise<void>;
  /**
   * Sets `completedAt` and clears `seq` — a completion is a change like
   * any other, and clearing `seq` is what makes it pending() so sync picks
   * it up, exactly the mechanism EntryStore.edit relies on for the same
   * reason. This is its own method, not "build a mutated Task and
   * upsert() it," because a caller reconstructing it by hand has no way to
   * know it must also no-op against a tombstone (below) — get that wrong
   * and a stale local completion can resurrect a Task someone else
   * deleted. No-op against a tombstone.
   */
  complete(id: string, completedAt: string): Promise<void>;
  /**
   * Clears `completedAt` and clears `seq` — the mirror of complete(),
   * carrying the same no-op-against-a-tombstone guarantee for the same
   * reason: undoing a completion is still a local mutation that must not
   * bring a deleted Task back.
   */
  uncomplete(id: string): Promise<void>;
  /**
   * Changes `content` and clears `seq`. Exists as its own method for the
   * same reason EntryStore.edit does: a correct rename has to keep the
   * search index in step with the new content — or search keeps
   * surfacing the Task by words no longer in it — and no-op against a
   * tombstone, which a caller building a mutated Task for upsert() has no
   * way to know it must do. Both are corruption that happens silently
   * rather than throwing if this is reinvented by hand instead of called.
   */
  rename(id: string, content: string): Promise<void>;
  /**
   * Changes `orderKey` and clears `seq`. Writes exactly one row — the
   * entire point of fractional indexing (ADR 0050): dragging a Task never
   * touches a sibling's row, so two Devices dragging different Tasks
   * offline never contend for the same row when they sync. A caller that
   * instead recomputed and wrote every sibling's orderKey to keep them
   * "tidy" would reintroduce exactly the row-per-sibling write integer
   * positions have, and the last-write-wins collision that comes with it.
   * No-op against a tombstone.
   */
  reorder(id: string, orderKey: string): Promise<void>;
  /**
   * Sets `date` and clears `seq` (issue #169) — mirrors rename()'s doc
   * comment for why this is its own method rather than upsert() with a
   * mutated Task: ./task-fields.ts's assertValidDate is what refuses a
   * `Z`-suffixed or otherwise malformed string here, and a caller building
   * its own patch object has no way to know it must call through that (or
   * must no-op against a tombstone, the same trap every setter here
   * guards against). `null` clears the date — a Task returning to Inbox's
   * undated state, the same state one created directly in Todo starts in.
   * No-op against a tombstone.
   */
  setDate(id: string, date: string | null): Promise<void>;
  /**
   * Sets `deadline` and clears `seq`. Refuses (throws) a `deadline`
   * carrying anything but `YYYY-MM-DD` — ./task-fields.ts's
   * assertValidDeadline — because a Deadline is date-only by definition
   * (CONTEXT.md's Deadline entry), not a looser shape this store happens
   * to also accept and coerce. `null` clears the deadline. No-op against a
   * tombstone.
   */
  setDeadline(id: string, deadline: string | null): Promise<void>;
  /**
   * Sets `duration` (minutes) and clears `seq`. Refuses (throws) a
   * duration on a Task whose *current* `date` doesn't carry a time, and
   * refuses one over 1440 (24 hours) — ./task-fields.ts's
   * assertValidDuration. Checked against the Task's current `date`, not a
   * `date` this same call might also be setting: change both by calling
   * setDate() then setDuration(), in that order. `null` clears the
   * duration. No-op against a tombstone.
   */
  setDuration(id: string, duration: number | null): Promise<void>;
  /**
   * Sets `priority` and clears `seq`. Refuses (throws) anything outside
   * 1-4 — ./task-fields.ts's assertValidPriority. Unlike the other three
   * setters above, there is no `null` case: `priority` isn't nullable (see
   * Task.priority's own doc comment, ./task-types.ts, on what "no
   * priority" means instead of an absent value). No-op against a
   * tombstone.
   */
  setPriority(id: string, priority: number): Promise<void>;
  /**
   * Sets `labelIds` and clears `seq` — mirrors the other #169-era setters
   * above for the same reason: a caller building its own patch object
   * has no way to know it must no-op against a tombstone, and this is
   * where that guarantee lives instead. Replaces the array wholesale
   * (there is no `addLabel`/`removeLabel` pair): the caller already has
   * the Task's current `labelIds` from list()/get() by the time it's
   * showing a label picker, so "read, splice, write back the whole
   * array" costs it nothing extra and keeps this store from needing to
   * define what "add an id already present" or "remove one that isn't"
   * mean. See ../task-types.ts's own doc comment on `labelIds` for why a
   * Task carries this as a plain array rather than through a join table.
   * No validation beyond the array shape itself: a `labelId` naming a
   * Label that doesn't exist, or that's since been removed, is an
   * accepted, transient state (../label-store.ts's remove() doc comment
   * explains why), not something this setter refuses. No-op against a
   * tombstone.
   */
  setLabelIds(id: string, labelIds: string[]): Promise<void>;
  /**
   * Advances a recurring Task to its next occurrence (issue #170's
   * recurrence engine, ../recurrence/) instead of completing it — a
   * recurring Task's checkbox never "un-ticks itself," and the Task never
   * enters the completed list (CONTEXT.md's Recurrence entry): only
   * `date` moves, `completedAt` stays null. `dateString` is re-parsed
   * fresh on every call, via ../recurrence/'s nextOccurrence, rather than
   * incrementing whatever `date` already holds — the string, not the
   * date it last resolved to, is what this project treats as the truth.
   *
   * `completedAt` is a real timestamp, exactly like complete()'s own
   * parameter above — this is a completion event even though it doesn't
   * set the `completedAt` column — and its first ten characters become
   * the recurrence engine's floating "now," the identical technique
   * ../task-views.ts's today() uses to derive a day-granular boundary
   * from a full timestamp.
   *
   * A bounded rule (a `starting`/`ending`/`for` clause whose window has
   * elapsed — ../recurrence/'s `{ kind: "ended" }` outcome) has no next
   * occurrence: this method then behaves like completeForever() below —
   * sets `completedAt` for real and clears `dateString` — because a
   * recurrence that has run out *is* an ordinary completed Task from that
   * point on, not a Task waiting for a next date it will never get.
   *
   * Throws if the Task has no `dateString` (a caller error: this method
   * is only for a Task the caller already knows is recurring) or if
   * `dateString` no longer parses (../recurrence/'s `{ kind: "refused" }`
   * outcome — data that reached this Device already corrupted, rather
   * than something this method can silently paper over). No-op against a
   * tombstone or an unknown id — checked before either throw becomes
   * reachable, the same ordering setDuration's own doc comment explains
   * for the identical reason. Clears `seq`.
   */
  advanceRecurring(id: string, completedAt: string): Promise<void>;
  /**
   * Ends a recurring Task's series and files it as an ordinary completed
   * Task — Shift+Click on a recurring task's checkbox ("Complete and
   * archive recurring task"), the end of the series, not "complete this
   * occurrence" (CONTEXT.md's Recurrence entry). Sets `completedAt` for
   * real — the one door through which a Task that carries a `dateString`
   * is allowed into listCompleted() — and clears `dateString` so a later
   * uncomplete() can't resurrect a recurrence the user deliberately
   * ended. `date` is left exactly as it was: the last occurrence a
   * completed Task carries is exactly as meaningful a record as it is
   * for a Task that was never recurring at all. No-op against a
   * tombstone, clears `seq`.
   */
  completeForever(id: string, completedAt: string): Promise<void>;
  /**
   * Moves an overdue Task to tomorrow. "Postponing an overdue recurring
   * task moves it to tomorrow" is this method's motivating case, but the
   * mechanics don't depend on recurrence at all — it's a plain one-day
   * shift of `date`, never a call into ../recurrence/'s engine, which is
   * exactly why a Task with no `dateString` can use it too. `today` is a
   * floating date-or-datetime string in ../task-views.ts's today()'s own
   * encoding — only its first ten characters matter, the calendar day
   * "tomorrow" is computed from (../recurrence/'s tomorrowOf). Preserves
   * whichever shape `date` already had: a timed `date` keeps its
   * time-of-day on the new day; an all-day `date` stays all-day. No-op
   * against a tombstone or a Task with no `date` at all — there is
   * nothing to postpone. Clears `seq`.
   */
  postpone(id: string, today: string): Promise<void>;
  /**
   * Tombstone, never a hard delete (ADR 0028's rule, applied to Tasks).
   * `seq IS NULL` means "no acknowledgement from the server yet," which
   * also covers "pushed, but the response was lost" — a window this
   * method can't tell apart from "never pushed." Hard-deleting in that
   * window lets the next sync return the Task as live again, with a fresh
   * `seq`: the resurrection trap EntryStore.remove's own doc comment
   * names, unchanged by which root noun it's applied to.
   */
  remove(id: string): Promise<void>;
  /**
   * Tasks with no sequence number, tombstones included — exactly
   * `seq IS NULL`. A tombstone awaiting push has `seq IS NULL` the same
   * way a newly created Task does (ADR 0028's Decision: a delete goes out
   * over the wire as the resulting state, same as any other change), so
   * this needs no tombstone-specific branch to pick it up.
   */
  pending(): Promise<Task[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  /**
   * Prefix search over `content`, literal text never query syntax
   * (EntryStore.search's own guarantees — quotes, `*`, and AND/OR/NOT in
   * the query are matched as literal characters, not parsed). An empty or
   * whitespace-only query matches nothing.
   *
   * Excludes both tombstoned and *completed* Tasks. A completed Task is
   * deliberately not searchable: Todo's search is "find something I still
   * need to act on," not a general archive query, and a completed Task
   * that resurfaced here would read as still-open to anyone who found it
   * this way. (A completed Task remains reachable through
   * listCompleted().)
   */
  search(query: string): Promise<Task[]>;
}
