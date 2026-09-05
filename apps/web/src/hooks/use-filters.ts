import type { Filter, FilterStore } from "@meologue/core";
import { DEFAULT_LABEL_COLOUR, mintId, parseFilterQuery } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { FILTERS_QUERY_KEY } from "@/lib/query-keys";

export interface AddFilterOverrides {
  /** One of LABEL_COLOURS' current palette hexes (Filter.colour's own doc comment on why a Filter shares Project/Label's palette). `DEFAULT_LABEL_COLOUR` when the reader hasn't picked one, mirroring a Project's/Label's own creation default. */
  colour?: string;
}

export interface UseFiltersResult {
  /** Every Filter, alphabetical (FilterStore.list()'s own guarantee). */
  filters: Filter[];
  /**
   * Creates a Filter from a name and a query, returning its freshly
   * minted id synchronously so a caller can navigate straight to the new
   * Filter's own screen (`/todo/filters/:id`) without waiting on the
   * write to land — the identical "mint here, mutate in the background"
   * shape use-tasks.ts's own `addTask` and use-projects.ts's own
   * `addProject` already take, extended here to hand the id back since,
   * unlike a freshly added Task or Project, a freshly created Filter is
   * immediately navigated to.
   *
   * **Throws synchronously**, before minting anything or writing
   * anything, on an empty name or a `query` `parseFilterQuery`
   * (@meologue/core) cannot parse — this is the validated creation door
   * criterion 6 asks for ("Save must not be offered for a query that
   * cannot be saved meaningfully"): `filter-view.tsx`'s own Save button
   * is already disabled whenever this would throw, so reaching this catch
   * block at all means either a race (the Task list changed under a
   * stale disabled-check) or a caller that skipped the check — either
   * way, refusing here is what keeps `FilterStore.upsert`'s own trusted
   * bulk door (../filter-store.ts) from ever being reached with text
   * nothing downstream could evaluate.
   */
  addFilter: (name: string, query: string, overrides?: AddFilterOverrides) => string;
  renameFilter: (id: string, name: string) => void;
  setFilterColour: (id: string, colour: string) => void;
  /**
   * Changes an existing Filter's own query. Returns the write's own
   * Promise, unlike every setter above — `FilterStore.setQuery` throws on
   * a query that doesn't parse (its own doc comment), and a caller-facing
   * query editor needs to `catch` that the same way use-projects.ts's own
   * `setProjectParent`/`addSection` do for their own validated doors,
   * rather than have it disappear into a mutation's own internal error
   * state.
   */
  setFilterQuery: (id: string, query: string) => Promise<void>;
  removeFilter: (id: string) => void;
}

/**
 * Owns Todo's Filters for whichever view is mounted under
 * EntryStoreLayout (issue #185) — the Filter-shaped sibling of
 * use-labels.ts/use-projects.ts, following their exact shape (a query, a
 * mutation per write, TanStack's own cache invalidation) for the
 * identical reason those two hooks' own header comments give for
 * mirroring use-history.ts.
 *
 * No `afterLocalWrite`/Sync-nudge seam, mirroring use-projects.ts's own
 * header comment: Filters carry no Sync stream at all yet
 * (../../packages/core/src/filter-store.ts's own header comment), so
 * there is nothing for a mutation here to nudge.
 */
export function useFilters(filterStore: FilterStore, deviceId: string): UseFiltersResult {
  const filtersQuery = useQuery({
    queryKey: FILTERS_QUERY_KEY,
    queryFn: () => filterStore.list(),
  });

  const filters = filtersQuery.data ?? [];

  function invalidateFilters() {
    return queryClient.invalidateQueries({ queryKey: FILTERS_QUERY_KEY });
  }

  const upsertMutation = useMutation({
    mutationFn: (filter: Filter) => filterStore.upsert([filter]),
    onSuccess: invalidateFilters,
  });

  function addFilter(name: string, query: string, overrides: AddFilterOverrides = {}): string {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      throw new Error("filter name must not be empty");
    }
    // Throws FilterParseError, uncaught here on purpose — this function's
    // own doc comment explains why the caller is expected to have
    // already refused to offer Save rather than reach this at all.
    parseFilterQuery(query);

    const id = mintId();
    const now = new Date().toISOString();
    upsertMutation.mutate({
      id,
      deviceId,
      name: trimmedName,
      colour: overrides.colour ?? DEFAULT_LABEL_COLOUR,
      query,
      createdAt: now,
      // Issue #196: starts equal to createdAt, the same single clock read.
      updatedAt: now,
      seq: null,
      syncedAt: null,
      deletedAt: null,
    });
    return id;
  }

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => filterStore.rename(id, name),
    onSuccess: invalidateFilters,
  });

  function renameFilter(id: string, name: string) {
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    renameMutation.mutate({ id, name: trimmed });
  }

  const setColourMutation = useMutation({
    mutationFn: ({ id, colour }: { id: string; colour: string }) =>
      filterStore.setColour(id, colour),
    onSuccess: invalidateFilters,
  });

  function setFilterColour(id: string, colour: string) {
    setColourMutation.mutate({ id, colour });
  }

  const setQueryMutation = useMutation({
    mutationFn: ({ id, query }: { id: string; query: string }) => filterStore.setQuery(id, query),
    onSuccess: invalidateFilters,
  });

  function setFilterQuery(id: string, query: string): Promise<void> {
    return setQueryMutation.mutateAsync({ id, query });
  }

  const removeMutation = useMutation({
    mutationFn: (id: string) => filterStore.remove(id),
    onSuccess: invalidateFilters,
  });

  function removeFilter(id: string) {
    removeMutation.mutate(id);
  }

  return { filters, addFilter, renameFilter, setFilterColour, setFilterQuery, removeFilter };
}
