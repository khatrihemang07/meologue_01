/**
 * A Comment is its own root noun beside Entry, Task, Project/Section and
 * Label (ADR 0047's move, made a fourth time — issue #180) — never a JSON
 * column on the Task the way `labelIds` is (../task-types.ts's own doc
 * comment on why *that* field is an array). Unlike the Labels attached to
 * a Task, Comments are unbounded in number and each one is individually
 * addressable — edited on its own, deleted on its own, with its own
 * `createdAt` — rather than replaced wholesale the way `setLabelIds`
 * replaces the whole array in one write. That is the shape of a second
 * table and a second store, not a bigger Task.
 *
 * A Task holds many Comments. Structurally this mirrors `Label`
 * (../label-types.ts) and `Task` (../task-types.ts) closely on purpose —
 * `deviceId`, `createdAt`, `seq`, `syncedAt`, `deletedAt` are the
 * identical sync-and-tombstone scaffolding every other root noun in this
 * codebase already carries (ADR 0028's rule, applied a fourth time), even
 * though nothing in this ticket wires a Comment Sync stream up to the
 * wire protocol or the server — issue #182 does one protocol bump
 * carrying Projects, Sections, Labels, Comments and Activity together.
 * Building the scaffolding in now, ahead of that bump, is free
 * (../label-store.ts's own header comment makes the identical argument
 * for Labels) and avoids a second migration to retrofit it later.
 *
 * Deliberately excludes the same collaboration columns Task's own header
 * comment refuses (`responsibleUid`, `workspaceId`, a role, `isShared`)
 * for the identical reason: meologue is one person's task list, and
 * nothing here is shared between people.
 *
 * **Deleting the Task a Comment belongs to does not touch this row.**
 * ../comment-store.ts's own header comment has the full reasoning: a
 * cross-store cleanup write would need the same non-atomic multi-table
 * write ../task-types.ts's `labelIds` doc comment already refuses for
 * the identical reason, and it costs nothing to skip — a tombstoned
 * Task's own `get()`/`list()` never resolve again, so nothing in this
 * app can ever open a view that would show this Comment's own Task as
 * live. The Comment sits in the table, unreachable, exactly the
 * "accepted, transient state" every other cross-store reference in this
 * codebase already is.
 */
export type Comment = {
  id: string;
  deviceId: string;
  /** The Task this Comment belongs to. */
  taskId: string;
  /**
   * The Comment's own words — Markdown, rendered by the identical
   * renderer an Entry's body and a Task's description both use
   * (apps/web's `entryProse`) — never a second renderer for a third kind
   * of Markdown text.
   */
  text: string;
  createdAt: string;
  /** Issue #196 — see Task.updatedAt's own doc comment (../task-types.ts) for the mechanism and reasoning, applied here unchanged. */
  updatedAt: string;
  seq: number | null;
  syncedAt: string | null;
  /** Tombstone (ADR 0028's rule, applied to Comments). */
  deletedAt: string | null;
};
