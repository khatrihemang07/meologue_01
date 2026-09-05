/**
 * A first-class object (issue #170, CONTEXT.md's Label entry): a name the
 * user attaches to a Task, freely, across Projects. Structurally this
 * mirrors `Task` (../task-types.ts) closely on purpose — `deviceId`,
 * `createdAt`, `seq`, `syncedAt`, `deletedAt` are the identical
 * sync-and-tombstone scaffolding TaskStore already carries (ADR 0028's
 * rule, applied a third time after Entry and Task) — issue #170 shipped
 * this scaffolding well before issue #182 actually wired a Label Sync
 * stream up to the wire protocol and the server; see label-store.ts's
 * header comment for why that scaffolding was worth having ahead of time
 * rather than deferred until the sync ticket that would go on to use it.
 * A Label that started without these columns and had them bolted on later
 * would have needed its own migration to add them, plus a backfill for
 * every row minted in between; starting with the same shape TaskStore
 * already proved out cost nothing and avoided that entirely.
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
  /** Issue #196 — see Task.updatedAt's own doc comment (../task-types.ts) for the mechanism and reasoning, applied here unchanged. */
  updatedAt: string;
  seq: number | null;
  syncedAt: string | null;
  /** Tombstone (ADR 0028's rule, applied to Labels, mirroring Task.deletedAt). */
  deletedAt: string | null;
};
