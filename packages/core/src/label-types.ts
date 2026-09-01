/**
 * A first-class object (issue #170, CONTEXT.md's Label entry): a name the
 * user attaches to a Task, freely, across Projects. Structurally this
 * mirrors `Task` (../task-types.ts) closely on purpose — `deviceId`,
 * `createdAt`, `seq`, `syncedAt`, `deletedAt` are the identical
 * sync-and-tombstone scaffolding TaskStore already carries (ADR 0028's
 * rule, applied a third time after Entry and Task), even though nothing
 * in this ticket wires a Label sync stream up to the wire protocol or the
 * server — see label-store.ts's header comment for why that scaffolding
 * exists now anyway rather than being deferred until a sync ticket adds
 * it. A Label that starts without these columns and has them bolted on
 * later would need its own migration to add them, plus a backfill for
 * every row minted in between; starting with the same shape TaskStore
 * already proved out costs nothing today and avoids that entirely.
 *
 * Deliberately excludes the same collaboration columns Task's own header
 * comment refuses (`responsibleUid`, `workspaceId`, a role, `isShared`)
 * for the identical reason: meologue is one person's task list, and nothing
 * here is shared between people.
 */
export type Label = {
  id: string;
  deviceId: string;
  /** What the user typed as the Label's name. Never validated for uniqueness — see label-fields.ts's assertValidLabelName for what *is* checked. */
  name: string;
  /**
   * One of the twenty hex values in label-colors.ts's LABEL_COLOURS —
   * Todoist's current palette, not the widely-cached pre-2024 one (that
   * module's own header comment has the full story). Stored as the hex
   * string itself rather than the palette's numeric `id`: a Label's own
   * row is the one place this app renders a swatch from, and reading a
   * hex straight off the row avoids a join (real or in-memory) against
   * LABEL_COLOURS just to answer "what colour is this."
   */
  colour: string;
  createdAt: string;
  seq: number | null;
  syncedAt: string | null;
  /** Tombstone (ADR 0028's rule, applied to Labels, mirroring Task.deletedAt). */
  deletedAt: string | null;
};
