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
 * Deliberately excludes date, priority, deadline, duration, project,
 * section and parent too. Those land in issue #169 and #171, each behind
 * its own migration — sequenced apart on purpose, so each migration's
 * blast radius is the one thing it's actually adding.
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
};
