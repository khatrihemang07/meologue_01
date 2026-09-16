import type { Label } from "./label-types";

/**
 * Issue #332: what Sync's acknowledgement arm hands the Label store — the
 * Label-shaped sibling of AcknowledgedTask (./task-store.ts, issue #244),
 * whose own doc comment carries the full reasoning and is not repeated
 * here.
 *
 * The short version, because it is the reason this type exists at all: an
 * acknowledgement cannot be applied unconditionally, because the user can
 * edit a row between the push going out and the response coming back —
 * renaming a Label, say — and applying it then reverts that edit *and*
 * stamps a `seq`, so `pending()` (which is exactly `seq IS NULL`) stops
 * seeing the row and nothing ever re-pushes it. Nor can it be guarded on
 * `updatedAt` the way LabelStore.applyPulled is: ADR 0065 tolerates the
 * Server holding an *older* `updatedAt`, so that guard would refuse the
 * acknowledgement forever and the row would re-push on every tick.
 */
export interface AcknowledgedLabel {
  /** The Server's current row for this id, as ADR 0059 returns it — a full row, so a write the Server refused against a tombstone teaches this Device the tombstone. */
  readonly confirmed: Label;
  /** The row this Device sent, exactly as `pending()` handed it over. Only its `updatedAt` is read. */
  readonly asPushed: Label;
}

/**
 * The Label-shaped sibling of TaskStore (./task-store.ts) — mirrored
 * section for section, exactly as that file's own header comment says
 * TaskStore mirrors EntryStore, so a reader who knows one recognises the
 * other.
 *
 * **Deliberately carries no Sync wiring beyond the scaffolding
 * (`seq`/`syncedAt`/`pending`/`getCursor`/`setCursor`) that costs nothing
 * to have and everything to retrofit.** TaskStore shipped this same
 * scaffolding in issue #168 well before its own Sync stream existed (its
 * own header comment says as much — "issue #171/#175"), and this ticket
 * repeats that choice for Labels rather than inventing a different
 * pattern for "a store that doesn't sync yet": a LabelStore built without
 * `seq`/tombstones today would need a real migration to retrofit them the
 * day Labels do get a Sync stream, backfilling every row minted in
 * between. Building it in now is free — the wire protocol integration
 * that would actually move a Label between Devices is the part this
 * ticket doesn't attempt, and stays that way until a future issue asks
 * for it.
 *
 * No `search()`: nothing in issue #170 asks Labels to be searchable, and
 * TaskStore.search's own justification (a completed Task shouldn't
 * surface in "find something I still need to act on") doesn't even apply
 * — there's no completed/active distinction for a Label to be filtered
 * out of. No `reorder()` either: TaskStore's fractional `orderKey` exists
 * because Tasks are dragged into a manual order a user cares about
 * (ADR 0050); nothing in this ticket or CONTEXT.md's Label entry asks for
 * a manual Label order, so list() below returns them alphabetically
 * instead — see SqliteLabelStore.list()'s own comment for why that's the
 * only ordering that means anything without inventing scope this ticket
 * doesn't ask for.
 */
export interface LabelStore {
  /** Active Labels — not tombstoned — ordered by name (case-insensitively), ties broken by id. */
  list(): Promise<Label[]>;
  /** One Label by id, or undefined if unknown or tombstoned. */
  get(id: string): Promise<Label | undefined>;
  /**
   * Sync's write path: upsert wholesale, exactly as TaskStore.upsert
   * does — and, as with TaskStore, there is deliberately no `add`: a new
   * Label is `upsert([label])`, the one door a local creation and a
   * (future) Sync round trip both use.
   */
  upsert(labels: Label[]): Promise<void>;
  /**
   * Sync's **pull** write path (issue #218) — the Cursor-read rows in a
   * SyncResponse, never the acknowledged ones. Mirrors
   * EntryStore.applyPulled exactly (./store.ts's own doc comment carries
   * the full rule and every reason behind it): an incoming row is
   * applied unless the local row is pending (`seq IS NULL`) and strictly
   * newer by `updatedAt`, and even then a tombstone still wins. The
   * acknowledged arm is applyAcknowledged below, not this method and not
   * `upsert` — see AcknowledgedLabel above for why an `updatedAt` guard
   * cannot be reused there.
   */
  applyPulled(labels: Label[]): Promise<void>;
  /**
   * Sync's **acknowledgement** write path (issue #332), mirroring
   * TaskStore.applyAcknowledged's issue #244 fix exactly — see that
   * method's own doc comment (./task-store.ts) for the full rule and the
   * reasoning behind every clause.
   *
   * Applies each confirmation **only while the local row is still the one
   * that was pushed**, compared on `updatedAt` against `asPushed`. A row
   * edited since the push — renamed, say — is left exactly as it is, and
   * left pending, so the next Sync tick carries the newer edit instead of
   * the acknowledgement quietly undoing it. A row that is no longer
   * pending is confirmed unconditionally: it has nothing local left to
   * lose, which is what keeps a redelivered acknowledgement idempotent.
   *
   * Until this method existed, this store's own doc comment asserted
   * (wrongly) that the acknowledgement arm "stays wholesale" on `upsert`
   * above — the identical false decision issue #244 already corrected for
   * Tasks, repeated here for Labels because nothing about a Label's own
   * `pending`/`seq` scaffolding makes it immune to the race: create a
   * Label (pushed, `seq: null`), rename it while that push is still in
   * flight, and the acknowledgement for the pushed shape lands wholesale
   * over the rename — stamping a real `seq` over the `seq: null` the
   * rename just set. `pending()` then sees nothing, so the rename never
   * re-pushes: a lost write, reached from the identical direction #244
   * named for Tasks.
   */
  applyAcknowledged(rows: readonly AcknowledgedLabel[]): Promise<void>;
  /** Changes `name` and clears `seq`. Refuses (throws) an empty name — ./label-fields.ts's assertValidLabelName. No-op against a tombstone. */
  rename(id: string, name: string): Promise<void>;
  /** Changes `colour` and clears `seq`. Refuses (throws) a hex outside label-colors.ts's current palette — ./label-fields.ts's assertValidLabelColour. No-op against a tombstone. */
  setColour(id: string, colour: string): Promise<void>;
  /**
   * Tombstone, never a hard delete (ADR 0028's rule, applied a third
   * time). A Task referencing this Label's id in its own `labelIds`
   * (../task-types.ts) is not touched here — see that field's own doc
   * comment for why a dangling reference left behind by a remove() is an
   * accepted, transient state rather than something this method reaches
   * across stores to clean up.
   */
  remove(id: string): Promise<void>;
  /** Labels with no sequence number, tombstones included — exactly `seq IS NULL`, mirroring TaskStore.pending(). */
  pending(): Promise<Label[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  /**
   * Issue #186 / ADR 0057 — see `EntryStore.catchUpRowShapeEpoch`'s own
   * doc comment (./store.ts) for the mechanism; `currentEpoch` here is
   * `protocol.ts`'s `ROW_SHAPE_EPOCH.labels`.
   */
  catchUpRowShapeEpoch(currentEpoch: number): Promise<void>;
}
