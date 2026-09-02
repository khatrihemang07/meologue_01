/**
 * The fan-out ADR 0048 asks for on both sides of "the Task owns the
 * text": renaming a Task refreshes the cached label in every Entry
 * referencing it, and completing/uncompleting a Task from Todo refreshes
 * every referencing Entry's own `[ ]`/`[x]` cache to match — the mirror of
 * `entry-row.tsx`'s `TaskReferenceItem`, which does the identical write in
 * the other direction (an Entry's own checkbox, ticked, writes the Task).
 *
 * In practice a Task is referenced by at most one Entry — Promotion
 * (promote-tasks.ts) is the only thing that ever creates a
 * `[[task:id|label]]` mark, and it only ever creates one, at the moment a
 * bare checkbox is Sent. This module does the general "every Entry
 * referencing it" search anyway, exactly as ADR 0048 states it, rather
 * than assuming the common case is the only case: nothing about the
 * dialect stops more than one Reference existing, and a fan-out that
 * silently only handled the first would be a correctness bug waiting for
 * a day this assumption stops holding.
 *
 * **Step 1 — narrow with the index.** `store.search(taskId)` runs the raw
 * uuid through the FTS5 index ADR 0014 already maintains — the identical
 * technique `day-referrers.ts`'s own module comment explains in full:
 * `unicode61` tokenizes a hyphen as a separator, so a uuid indexes as the
 * same run of hex tokens whether it sits inside `[[task:<id>|...]]` or
 * appears (vanishingly unlikely) as incidental prose, and searching the
 * identical string finds every Entry carrying it with no schema change.
 *
 * **Step 2 — confirm by parsing.** Every candidate is re-parsed with
 * `parseEntryMarkdown` and walked for a real `taskReference` node naming
 * this exact Task — `referencedTaskOf` (inline-markdown.ts), the same
 * detection Promotion's own loop guard depends on, reused rather than
 * re-derived so the two can never disagree about what counts as a
 * reference.
 */
import type { Entry, EntryStore } from "@meologue/core";
import type { EntryBlockNode } from "@/lib/inline-markdown";
import {
  parseEntryMarkdown,
  referencedTaskOf,
  refreshTaskReferenceLabel,
} from "@/lib/inline-markdown";

/** The Entries that hold a live `[[task:<taskId>|...]]` Reference, in `store.search`'s own (newest-first) order. */
export async function findEntriesReferencingTask(
  store: Pick<EntryStore, "search">,
  taskId: string,
): Promise<Entry[]> {
  const candidates = await store.search(taskId);
  return candidates.filter((candidate) =>
    referencesTask(parseEntryMarkdown(candidate.body), taskId),
  );
}

function referencesTask(blocks: readonly EntryBlockNode[], taskId: string): boolean {
  for (const block of blocks) {
    if (block.kind === "prose") {
      continue;
    }
    for (const item of block.items) {
      if (item.task !== undefined && referencedTaskOf(item)?.taskId === taskId) {
        return true;
      }
      if (referencesTask(item.content, taskId)) {
        return true;
      }
    }
  }
  return false;
}

interface TaskMarkerSpan {
  readonly markerFrom: number;
  readonly markerTo: number;
}

/** Every checkbox marker in `body` belonging to a `[[task:<taskId>|...]]` Reference, in document order. */
function taskReferenceMarkers(body: string, taskId: string): TaskMarkerSpan[] {
  const out: TaskMarkerSpan[] = [];
  collectTaskMarkers(parseEntryMarkdown(body), taskId, out);
  return out;
}

function collectTaskMarkers(
  blocks: readonly EntryBlockNode[],
  taskId: string,
  out: TaskMarkerSpan[],
): void {
  for (const block of blocks) {
    if (block.kind === "prose") {
      continue;
    }
    for (const item of block.items) {
      if (item.task !== undefined && referencedTaskOf(item)?.taskId === taskId) {
        out.push({ markerFrom: item.task.markerFrom, markerTo: item.task.markerTo });
      }
      collectTaskMarkers(item.content, taskId, out);
    }
  }
}

/** Sets every `[[task:<taskId>|...]]` checkbox marker in `body` to `checked` — `toggleTaskAt`'s explicit-state sibling, applied at every matching span rather than just one. */
function setAllTaskMarkersChecked(body: string, taskId: string, checked: boolean): string {
  const markers = taskReferenceMarkers(body, taskId);
  if (markers.length === 0) {
    return body;
  }
  let out = "";
  let cursor = 0;
  for (const { markerFrom, markerTo } of markers) {
    out += body.slice(cursor, markerFrom);
    out += checked ? "[x]" : "[ ]";
    cursor = markerTo;
  }
  out += body.slice(cursor);
  return out;
}

/**
 * Renaming a Task refreshes the cached label in every Entry referencing
 * it (ADR 0048) — `use-tasks.ts`'s `renameTask` is this function's one
 * caller. Each changed Entry goes through `store.edit`, which clears
 * `seq` (ADR 0028) exactly as an ordinary edit does — that is the whole
 * mechanism ADR 0039's server-side staleness query needs, so nothing
 * digest-specific is done here: "a cache write still counts as editing
 * the Entry" falls out of calling the same `edit` an ordinary edit calls,
 * not from a second, bespoke staleness write.
 */
export async function syncTaskReferenceLabel(
  store: Pick<EntryStore, "search" | "edit">,
  taskId: string,
  label: string,
): Promise<void> {
  const entries = await findEntriesReferencingTask(store, taskId);
  for (const entry of entries) {
    const next = refreshTaskReferenceLabel(entry.body, taskId, label);
    if (next !== entry.body) {
      await store.edit(entry.id, next);
    }
  }
}

/**
 * Completing or uncompleting a Task from Todo refreshes every referencing
 * Entry's own `[ ]`/`[x]` cache to match (ADR 0048's "ticking writes the
 * Task; the body's marker follows as a consequence," applied from the
 * Todo side of the same act) — `use-tasks.ts`'s `completeTask`/
 * `uncompleteTask` are this function's callers.
 *
 * Deliberately not called for `advanceRecurringTask`/`completeForeverTask`:
 * a recurring Task's own advance never completes it (CONTEXT.md's
 * Recurrence entry — the checkbox never "un-ticks itself," and this
 * function has no notion of an Occurrence to write one for), and
 * `completeForeverTask` needs no cache write for correct rendering —
 * `entry-row.tsx`'s `TaskReferenceItem` resolves a NON-recurring Task's
 * checked state live off `tasks`/`completedTasks` regardless of what the
 * body's own cache says, so the write this function does is a durability
 * nicety (Export, an unsynced peer) for the one case — an ordinary,
 * non-recurring completion — where the cache and the live Task can
 * legitimately be asked to agree everywhere at once. A recurring Task's
 * own occurrence checkmark is pinned per-Entry instead (`renderListItem`
 * in `entry-row.tsx`), which is exactly why a blanket rewrite here would
 * be wrong for it.
 */
export async function syncTaskReferenceChecked(
  store: Pick<EntryStore, "search" | "edit">,
  taskId: string,
  checked: boolean,
): Promise<void> {
  const entries = await findEntriesReferencingTask(store, taskId);
  for (const entry of entries) {
    const next = setAllTaskMarkersChecked(entry.body, taskId, checked);
    if (next !== entry.body) {
      await store.edit(entry.id, next);
    }
  }
}
