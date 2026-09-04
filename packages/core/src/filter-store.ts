import type { Filter } from "./filter-types";

/**
 * The Filter-shaped sibling of LabelStore (./label-store.ts) — mirrored
 * section for section, exactly as that file's own header comment says
 * LabelStore mirrors TaskStore, so a reader who knows one recognises the
 * other.
 *
 * **Storage: local only, deliberately sync-ready — issue #185 wires no
 * eighth Sync stream.** This carries the identical full
 * `seq`/`syncedAt`/`deletedAt`/`pending()`/`getCursor()`/`setCursor()`/
 * `catchUpRowShapeEpoch()` scaffolding LabelStore shipped in issue #170,
 * well before Labels ever got a real Sync stream (issue #182) —
 * label-store.ts's own header comment states the reasoning this repeats
 * rather than re-derives: a FilterStore built without this scaffolding
 * today would need a real migration to retrofit it the day Filters do
 * get a Sync stream, backfilling every row minted in between; building it
 * in now is free. Issue #182 already demonstrated the cost of the
 * opposite choice directly — giving a noun a Sync stream (the actual wire
 * protocol integration: `protocol.ts`'s `ROW_SHAPE_EPOCH`, `sync-
 * engine.ts`'s per-stream fetch/push, `server/src/sync.rs`'s table — is
 * its own ticket with its own acceptance bar, not a checkbox this one
 * quietly ticks along the way. Nothing in issue #185's acceptance
 * criteria asks a Filter to reach another Device, so that ticket stays
 * unopened: `catchUpRowShapeEpoch` exists on this interface and on both
 * implementations below, but nothing calls it yet — the identical
 * "built, not yet wired to a caller" posture LabelStore's own setters
 * carried for one release between issue #170 and #182.
 *
 * No `search()`: the same reasoning LabelStore's own header comment gives
 * applies unchanged — nothing asks a Filter itself to be searchable
 * (Todo's own Search, CONTEXT.md's Search entry, narrows Tasks by their
 * own words, never Filters), and there is no completed/active
 * distinction here for one to filter out of. No `reorder()`/`orderKey`
 * either, for the identical reason LabelStore has none: nothing in issue
 * #185's acceptance criteria asks for a manual Filter order, so `list()`
 * below returns them alphabetically instead, mirroring LabelStore.list().
 */
export interface FilterStore {
  /** Active Filters — not tombstoned — ordered by name (case-insensitively), ties broken by id. */
  list(): Promise<Filter[]>;
  /** One Filter by id, or undefined if unknown or tombstoned. */
  get(id: string): Promise<Filter | undefined>;
  /**
   * Sync's write path: upsert wholesale, exactly as LabelStore.upsert
   * does — and, as with LabelStore, there is deliberately no `add`: a new
   * Filter is `upsert([filter])`, the one door a local creation and a
   * (future) Sync round trip both use. Does **not** validate `query` —
   * see ./filter-fields.ts's `assertValidFilterQuery` own doc comment for
   * why that check lives on `setQuery` below instead, the same "trusted
   * bulk door vs. validated setter" split every other store in this
   * codebase already draws.
   */
  upsert(filters: Filter[]): Promise<void>;
  /** Changes `name` and clears `seq`. Refuses (throws) an empty name — ./filter-fields.ts's assertValidFilterName. No-op against a tombstone. */
  rename(id: string, name: string): Promise<void>;
  /** Changes `colour` and clears `seq`. Refuses (throws) a hex outside label-colors.ts's current palette — ./filter-fields.ts's assertValidFilterColour. No-op against a tombstone. */
  setColour(id: string, colour: string): Promise<void>;
  /**
   * Changes `query` and clears `seq`. Refuses (throws a `FilterParseError`,
   * ./filter-query/types.ts) a query ./filter-query/parser.ts's
   * `parseFilterQuery` cannot parse — ./filter-fields.ts's
   * `assertValidFilterQuery`. No-op against a tombstone. This is the one
   * guarantee this store makes about `Filter.query`'s own contents: a
   * Filter reached through this door always holds a query that parses,
   * which is what lets every reader of `Filter.query` (the results page,
   * a future "run this Filter" surface) call `parseFilterQuery` on it
   * without a second, defensive try/catch of its own.
   */
  setQuery(id: string, query: string): Promise<void>;
  /**
   * Tombstone, never a hard delete (ADR 0028's rule, applied to Filters).
   * Nothing else in this codebase references a Filter's id the way a
   * Task references a Label's (`Task.labelIds`) — a Filter is a saved
   * query, not something anything else points at — so removing one
   * leaves nothing dangling elsewhere to account for.
   */
  remove(id: string): Promise<void>;
  /** Filters with no sequence number, tombstones included — exactly `seq IS NULL`, mirroring LabelStore.pending(). */
  pending(): Promise<Filter[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  /**
   * Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
   * comment (./store.ts) for the mechanism. Exists on every store
   * regardless of whether it Syncs yet (this interface's own header
   * comment) — `currentEpoch` would be `protocol.ts`'s
   * `ROW_SHAPE_EPOCH.filters` the day that map gains one, but nothing
   * calls this yet, since Filters carry no Sync stream (this interface's
   * own header comment).
   */
  catchUpRowShapeEpoch(currentEpoch: number): Promise<void>;
}
