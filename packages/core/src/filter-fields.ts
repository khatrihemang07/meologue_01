import { parseFilterQuery } from "./filter-query/parser";
import type { Filter } from "./filter-types";
import { DEFAULT_LABEL_COLOUR, isValidLabelColour } from "./label-colors";

/**
 * Validation for Filter's own fields — the Filter-shaped sibling of
 * label-fields.ts and project-fields.ts, called from every FilterStore
 * implementation's setter rather than re-derived by each, for the
 * identical reason those two modules' own header comments give: a rule
 * checked in only one implementation is a rule the shared contract suite
 * (test-support/filter-store-contract.ts) would never catch the other
 * implementation getting wrong.
 */

/** Throws on an empty or whitespace-only name — a Filter with no name isn't a lesser Filter, it's not a Filter, mirroring assertValidLabelName/assertValidProjectName. */
export function assertValidFilterName(name: string): void {
  if (name.trim() === "") {
    throw new Error("filter name must not be empty");
  }
}

/** Throws unless `colour` is one of label-colors.ts's twenty current palette values — see Filter.colour's own doc comment for why a Filter shares Project/Label's palette rather than inventing its own. */
export function assertValidFilterColour(colour: string): void {
  if (!isValidLabelColour(colour)) {
    throw new Error(
      `colour must be one of LABEL_COLOURS' current palette, got ${JSON.stringify(colour)}`,
    );
  }
}

/**
 * Throws a `FilterParseError` (./filter-query/types.ts) unless `query`
 * parses cleanly — the one place a query is validated before it reaches
 * storage. `FilterStore.setQuery` (./filter-store.ts) is the only store
 * method that calls this: `upsert()`, like every store in this codebase,
 * is the trusted bulk door a local creation and a future Sync round trip
 * both use, and trusts its caller the identical way
 * `LabelStore.upsert`/`ProjectStore.upsertProjects` do rather than
 * re-validating data that may already have been validated once, on
 * whichever Device it was first written on. A reader creating a fresh
 * Filter from Todo's own "New Filter" screen gets the identical
 * refusal at the UI layer instead (criterion 6: "Save must not be
 * offered for a query that cannot be saved meaningfully") — see
 * apps/web's `filter-view.tsx` for where that check actually lives for
 * the create path.
 */
export function assertValidFilterQuery(query: string): void {
  parseFilterQuery(query);
}

/**
 * Fills in `colour` where an incoming Filter omits it, mirroring
 * label-fields.ts's withDefaultLabelColour: `colour` is required on
 * `Filter` (not `?`-optional — every local caller states it explicitly,
 * ../task-types.ts's own comment makes the identical argument), so this
 * exists only as the safety net for a Filter arriving over Sync from a
 * Device on an older build whose JSON has no such key, once a sync
 * stream for Filters exists at all.
 */
export function withDefaultFilterColour(f: Filter): Filter {
  return { ...f, colour: f.colour ?? DEFAULT_LABEL_COLOUR };
}
