import type { Label, LabelStore } from "@meologue/core";
import { DEFAULT_LABEL_COLOUR, mintId } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { LABELS_QUERY_KEY } from "@/lib/query-keys";

export interface UseLabelsResult {
  /** Every active Label, alphabetical (LabelStore.list()'s own guarantee). */
  labels: Label[];
  /**
   * Turns issue #170's quick-add parser's `labelNames` (a Task's `%label`
   * tokens, resolved to plain strings — see packages/core/src/quick-add/
   * types.ts's own doc comment on why the parser itself never resolves a
   * name to an id: it carries no LabelStore) into the `labelIds` a Task
   * actually stores. Find-or-create, matching Todoist's own quick-add
   * behaviour for a `@label` that doesn't exist yet: a name with no live
   * Label of that name (case-insensitively — Label names are never
   * validated for uniqueness, label-fields.ts's own comment on
   * assertValidLabelName, so this is the one place a duplicate is quietly
   * avoided rather than minted) gets a fresh one, coloured
   * DEFAULT_LABEL_COLOUR, exactly as a Label created any other way starts.
   *
   * Not a TaskStore concern, and not folded into use-tasks.ts's addTask:
   * resolving a name to an id is Label bookkeeping, upserting a Task with
   * the resulting ids is Task bookkeeping, and add-task-form.tsx's own
   * caller (todo-page.tsx) is what already has to await this before it can
   * build the Task literal at all — a synchronous addTask has nothing to
   * await partway through its own mutation.
   *
   * Returns ids in `names`' own order, de-duplicated — a Task's
   * `labelIds` is an ordered array (../../packages/core/src/task-types.ts's
   * own doc comment on why: "the order Labels were added in" is preserved
   * for free), and typing the same `%label` twice in one line should not
   * duplicate it in that order.
   */
  resolveLabelIds: (names: string[]) => Promise<string[]>;
}

/**
 * Owns Todo's Labels for whichever view is mounted under EntryStoreLayout
 * (issue #170) — the Label-shaped sibling of use-tasks.ts, following its
 * exact shape (a query, a mutation, a shared `afterLocalWrite` refresh)
 * for the identical reason that file's own header comment gives for
 * mirroring use-history.ts.
 *
 * Deliberately thin: this ticket's web-side brief (170-brief.md's own Part
 * D) never asks for a Labels management page — renaming, recolouring or
 * deleting a Label — only for resolving what a reader typed into the add
 * field. `rename`/`setColour`/`remove` stay unreachable from `apps/web`
 * until a future ticket asks a UI to reach them, the same "built, not yet
 * wired to a control" posture TaskStore's own setters had for one release
 * between #168 and #169.
 */
export function useLabels(labelStore: LabelStore, deviceId: string): UseLabelsResult {
  const labelsQuery = useQuery({
    queryKey: LABELS_QUERY_KEY,
    queryFn: () => labelStore.list(),
  });

  const labels = labelsQuery.data ?? [];

  const upsertMutation = useMutation({
    mutationFn: (newLabels: Label[]) => labelStore.upsert(newLabels),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LABELS_QUERY_KEY }),
  });

  async function resolveLabelIds(names: string[]): Promise<string[]> {
    if (names.length === 0) {
      return [];
    }
    // Read fresh off the query cache rather than the `labels` closed over
    // above: two `%label` tokens resolved back-to-back in the same call
    // (this function's own loop below) must see a Label the first one just
    // minted, or the second would create a duplicate instead of reusing
    // it — `labels` from the render that triggered this call is a snapshot
    // from before any of that happens.
    let current = queryClient.getQueryData<Label[]>(LABELS_QUERY_KEY) ?? labels;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const existing = current.find((label) => label.name.toLowerCase() === name.toLowerCase());
      let id: string;
      if (existing !== undefined) {
        id = existing.id;
      } else {
        const created: Label = {
          id: mintId(),
          deviceId,
          name,
          colour: DEFAULT_LABEL_COLOUR,
          createdAt: new Date().toISOString(),
          seq: null,
          syncedAt: null,
          deletedAt: null,
        };
        await upsertMutation.mutateAsync([created]);
        current = [...current, created];
        id = created.id;
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  return { labels, resolveLabelIds };
}
