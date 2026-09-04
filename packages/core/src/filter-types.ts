/**
 * A first-class object (issue #185, CONTEXT.md's Filter entry: "A saved
 * query over Tasks"). Structurally this mirrors `Label` (./label-types.ts)
 * and `Project` (./project-types.ts) closely on purpose — `deviceId`,
 * `createdAt`, `seq`, `syncedAt`, `deletedAt` are the identical
 * sync-and-tombstone scaffolding every root-ish store in this codebase
 * carries (ADR 0028's rule, applied a sixth time), even though issue #185
 * wires no Filter Sync stream up to the wire protocol or the server — see
 * filter-store.ts's own header comment for why that scaffolding is worth
 * having ahead of time rather than deferred until the sync ticket that
 * would go on to use it, the identical argument label-store.ts's header
 * comment already made for Labels.
 *
 * `colour` exists for the identical reason `Project.colour` does — its
 * own doc comment already names the source: "Projects, Labels and
 * Filters share one palette in Todoist," so this reuses
 * `label-colors.ts`'s `LABEL_COLOURS` rather than a Filter-specific one.
 *
 * Deliberately excludes the same collaboration columns Task's own header
 * comment refuses (`responsibleUid`, `workspaceId`, a role, `isShared`)
 * for the identical reason: meologue is one person's task list, and
 * nothing here is shared between people.
 */
export type Filter = {
  id: string;
  deviceId: string;
  /** What the user typed as the Filter's name. Never validated for uniqueness, mirroring Label.name and Project.name — see ./filter-fields.ts's assertValidFilterName for what *is* checked. */
  name: string;
  /** One of label-colors.ts's twenty current palette hexes — see this type's own header comment for why Filter shares Project/Label's palette rather than inventing its own. */
  colour: string;
  /**
   * What the user typed as the query — Todo's own little grammar
   * (./filter-query/, ADR 0058), stored **unchanged**, exactly as
   * `Task.dateString` stores a Recurrence's literal rule rather than a
   * pre-computed schedule (that field's own doc comment gives the
   * identical reasoning: "the string is the truth," re-parsed fresh on
   * every read rather than compiled once and drifting from what the user
   * actually typed). Never itself a `TaskStore` query — a Filter is
   * matched against whatever Tasks a caller already has in memory
   * (./filter-query/evaluate.ts's own header comment), the same
   * "platform-free pure function over an in-memory list" rule
   * ./task-views.ts's `today()` already follows.
   *
   * `FilterStore.setQuery` (./filter-store.ts) is the one validated door
   * that ever changes this field on an existing Filter, and it refuses
   * (throws) a query `./filter-query/parser.ts`'s `parseFilterQuery`
   * cannot parse — see that method's own doc comment for why a Filter
   * reachable through the ordinary edit path can never hold unparseable
   * text, and criterion 6's own "a query that cannot be parsed says so
   * plainly" for why that guarantee exists at all.
   */
  query: string;
  createdAt: string;
  seq: number | null;
  syncedAt: string | null;
  /** Tombstone (ADR 0028's rule, applied to Filters, mirroring Label.deletedAt/Project.deletedAt). */
  deletedAt: string | null;
};
