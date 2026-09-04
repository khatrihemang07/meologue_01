import type { Project } from "@meologue/core";

/**
 * A Task's own Project name, for a cross-Project surface that has to name
 * where a Task lives rather than leaving it implicit the way a view
 * already scoped to one Project can. `"Inbox"` both for `projectId ===
 * null` (Todo's own unfiled bucket) and for an id that no longer resolves
 * against `projects` — a Project this Device hasn't Synced yet, or one
 * that was archived/deleted — the identical "unresolvable reads as the
 * least-committal answer" stance `entry-row.tsx`'s own Task Reference
 * takes for a Task it cannot resolve at all, applied here to one field of
 * a Task it CAN resolve.
 *
 * Pulled out of `task-search-page.tsx` (issue #183's own local
 * `projectNameFor`) rather than left there alone: `task-schedule-chips.tsx`
 * (issue #181) needs the identical lookup for its own Project chip, and a
 * Task's location should read identically wherever either renders it,
 * not by two copies of "find it in `projects`, fall back to Inbox"
 * happening to agree.
 */
export function projectNameFor(projects: readonly Project[], projectId: string | null): string {
  if (projectId === null) {
    return "Inbox";
  }
  return projects.find((p) => p.id === projectId)?.name ?? "Inbox";
}
