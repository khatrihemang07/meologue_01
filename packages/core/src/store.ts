import type { Entry } from "./types";

/**
 * A keyset page argument for list() (issue #79). `before` bounds the
 * result to Entries strictly *older* than the given (createdAt, id) pair
 * in list()'s own order (createdAt desc, then id desc — see list()'s doc
 * comment); `limit` caps how many rows come back. Both are independently
 * optional, and calling list() with no argument at all — or with `{}` — is
 * unchanged from before this argument existed: every live Entry, newest
 * first.
 *
 * `{ limit }` alone gives the newest N Entries (a fresh page). `{ before }`
 * alone gives everything older than a cursor, unbounded — the shape a
 * boundary-aware "refresh just the newest page" read needs, so it can ask
 * for "everything newer than where the next page starts" without also
 * hard-coding a count that might now be wrong (see
 * apps/web/src/lib/entries-pagination.ts's refreshNewestEntriesPage).
 * Together, `{ before, limit }` walks backward through History a page at a
 * time.
 *
 * ADR 0016's "Alternatives considered" rejected widening EntryStore with a
 * paginated read — at the time, nothing needed one, and the interface
 * changing for every implementation and the contract suite bought nothing.
 * That calculus is what changed here, not the caution behind it: this
 * argument is optional, list() with no argument is byte-identical to
 * before, and Export (settings-page.tsx, which calls `store.list()` with
 * no argument) keeps reading everything untouched. This is that ADR's own
 * rejected alternative, but scoped exactly to what makes it safe.
 */
export interface EntryPage {
  before?: { createdAt: string; id: string };
  limit?: number;
}

export interface EntryStore {
  /**
   * Every live Entry (tombstones excluded — ADR 0028), newest first by
   * createdAt, ties broken by id descending (Entry ids are time-ordered
   * uuidv7, so an ascending tie-break would order same-millisecond Entries
   * oldest-first inside an otherwise newest-first list). With no `page`
   * argument this returns the whole History, exactly as it always has —
   * Export relies on that. See EntryPage's own doc comment for what a page
   * argument does.
   */
  list(page?: EntryPage): Promise<Entry[]>;
  /**
   * Writes rows wholesale — every column taken from the Entry handed over,
   * whatever the local row currently says. This is the right shape for a
   * local capture and for Sync's *acknowledgement* path (ADR 0059), and
   * deliberately the wrong one for Sync's pull: see applyPulled below.
   */
  upsert(entries: Entry[]): Promise<void>;
  /**
   * Sync's **pull** write path (issue #215 / ADR 0068) — the Cursor-read
   * rows in a SyncResponse, never the acknowledged ones.
   *
   * upsert() overwrites a row unconditionally. That is correct when this
   * Device asked for the write, and wrong for a pull, because a pull can
   * arrive while a local change is still waiting to be pushed. The row is
   * then overwritten *and* stamped with the Server's `seq`, so it also
   * stops looking pending — nothing re-pushes it, and the local change is
   * gone with no error and no conflict anywhere. The window is widest
   * straight after a Restore, which resets every Cursor to 0 (ADR 0064)
   * so the very next pull is the entire History at once, and widest of
   * all for a write made at store-open: ADR 0053's Task backfill and
   * ADR 0067's soft-break pass both rewrite bodies exactly then.
   *
   * **An incoming row is applied unless the local row is pending and
   * strictly newer.** Three clauses, each carrying its own reason:
   *
   * - *pending* is `seq IS NULL` — the same "the Server has not
   *   acknowledged this yet" signal edit(), remove() and pending()
   *   already share. A row the Server has acknowledged has nothing local
   *   left to lose, so it is overwritten exactly as before.
   * - *strictly newer* compares `updatedAt`, which ADR 0065 put on the
   *   wire and left for whoever next revisited Sync's conflict rule.
   *   Compared at millisecond precision rather than as raw strings —
   *   the Server and this client do not write the field in the same
   *   shape, and a byte-wise compare of the two is not chronological
   *   order in either direction. `SqliteEntryStore.applyPulled` has the
   *   formats and both failures worked through.
   *   A tie applies rather than refuses, for two reasons. The incoming
   *   row has been through the Server and this Device's has not, so on
   *   a genuine tie the Server's copy is the better default. And the
   *   normalisation above turns any sub-millisecond difference into a
   *   tie, where applying is the direction that cannot strand a row.
   *   (It is *not* what rescues this Device's own row coming back with
   *   a `seq` on it — `sync-engine.ts` applies `acknowledged_entries`
   *   through `upsert()` before this method sees the Cursor-read arm,
   *   so such a row already has a `seq` and is taken by the first
   *   clause. That belongs to the acknowledgement path, not here.)
   * - *unless it is a tombstone* — deletion is terminal in both
   *   directions (ADR 0064), so an incoming tombstone lands over a newer
   *   local edit, the mirror of edit()'s own `WHERE deleted_at IS NULL`
   *   guard refusing to resurrect one.
   *
   * **ADR 0028's conflict rule is untouched.** Last-writer-wins by Server
   * arrival still decides every conflict the Server ever sees. A local
   * edit that has not been pushed has not reached that ordering at all;
   * refusing to discard it is what lets it get there. A genuinely newer
   * row from another Device still wins, exactly as before.
   *
   * **The acknowledgement path knowingly does not use this**, and that is
   * not an oversight — ADR 0068's Consequences names the narrower race it
   * leaves open. An `updatedAt` guard there would deadlock on ADR 0065's
   * own tolerated divergence: an edit landing on identical content leaves
   * the Server holding an *older* `updatedAt` than this Device, so the
   * acknowledgement would be refused forever and the row would re-push on
   * every tick.
   */
  applyPulled(entries: Entry[]): Promise<void>;
  pending(): Promise<Entry[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  /**
   * Entries whose body contains a word starting with `query`, in the same
   * order as list() (ADR 0014). Matching is prefix-based and the query
   * text is always taken literally, never as query syntax. An empty or
   * whitespace-only query matches nothing.
   */
  search(query: string): Promise<Entry[]>;
  /**
   * Changes an Entry's body locally — `A -> B` (ADR 0028). This exists as
   * its own method, rather than leaving callers to build a mutated Entry
   * and pass it to upsert(), because a correct edit has to do four things
   * a caller has no way to know it must do:
   *
   * - clear `seq`, which is what makes the edit pending — see the
   *   implementation for why this is not a side effect of some other
   *   mechanism but is *the* mechanism sync uses to notice the change
   * - never touch `createdAt`: editing an Entry does not move it in
   *   History (CONTEXT.md's domain guarantee)
   * - keep the FTS index in step with the new body, or Search keeps
   *   surfacing the Entry by words that are no longer in it
   * - no-op against a tombstone, so a stale local edit can never
   *   resurrect an Entry someone else deleted
   *
   * A caller that forgets any one of these corrupts data silently rather
   * than throwing — that's the whole reason this is a method on the store
   * instead of a recipe callers re-derive each time.
   */
  edit(id: string, body: string): Promise<void>;
  /**
   * Removes an Entry from History locally — `A -> nothing` (ADR 0028), a
   * tombstone, never a hard delete. Exists as its own method for the same
   * reason edit() does: a correct removal has to do four things a caller
   * building a mutated Entry for upsert() has no way to know it must do:
   *
   * - set `deletedAt` and blank `body`, so the tombstone doesn't assert
   *   both "deleted" and "still says X" at once
   * - clear `seq`, so the tombstone becomes pending and sync pushes it,
   *   the same mechanism edit() relies on
   * - remove the Entry from the FTS index, so a deleted Entry can't still
   *   surface in Search results
   * - never hard-delete the row, including while `seq` is null — `seq
   *   IS NULL` means "no acknowledgement from the server yet," which also
   *   covers "pushed, but the response was lost," a window a hard delete
   *   here can't tell apart from "never pushed." Hard-deleting in that
   *   window means the next pull can return the Entry as live again, with
   *   a fresh `seq`, and it resurrects permanently.
   *
   * A caller that forgets any one of these corrupts data silently rather
   * than throwing.
   */
  remove(id: string): Promise<void>;
  /**
   * The live (non-deleted) Entries among `ids`, in no particular order —
   * a direct-by-id lookup, not a page of History. Exists for callers that
   * already know which specific ids they want and can't get them from
   * list(): grounding-disclosure.tsx is the motivating case (a regression
   * in issue #79) — a Grounding id can name an Entry that's genuinely
   * local but simply hasn't been paged into whatever window of History
   * list() has loaded so far, and scanning that loaded window for the id
   * was silently wrong the moment paging shipped. getMany() bypasses
   * paging entirely and asks the store directly.
   *
   * An id this Device has never received, and an id whose Entry is now a
   * tombstone (ADR 0028), are both simply absent from the result — the
   * same "absent means not here" contract list() and search() already
   * give tombstones. A deleted Entry must never come back through this
   * method: CONTEXT.md's Grounding entry requires an Answer's disclosed
   * basis to be honest, and resurrecting a deleted Entry into a Grounding
   * disclosure would be exactly the kind of invented past that rule
   * forbids. Callers cannot (and don't need to) tell "never reached this
   * Device" apart from "reached it, then was deleted here" from this
   * method alone — both simply produce no result, which is the only
   * distinction the "hasn't reached this Device yet" message is allowed
   * to describe.
   *
   * An empty `ids` array returns an empty result without touching the
   * database — the common case once the caller has already resolved
   * everything it needed from a smaller set of ids.
   */
  getMany(ids: string[]): Promise<Entry[]>;
  /**
   * Issue #186 / ADR 0057. Must be called once, before this stream's own
   * Cursor is read for a sync request — `sync-engine.ts`'s `sync()` does
   * this for every stream, before its `while` loop begins, so no
   * implementation needs to call it from anywhere else.
   *
   * Compares `currentEpoch` (`protocol.ts`'s `ROW_SHAPE_EPOCH.entries`)
   * against the highest value this Device has ever recorded catching up
   * to for this stream (kept alongside the Cursor itself — ADR 0007's own
   * argument for why the Cursor lives in the same database as the rows
   * it claims are already local applies verbatim here: an epoch claiming
   * this Device re-walked a stream, backed by a database that never
   * actually held that walk, is the same failure mode as a Cursor
   * claiming progress the rows behind it never made). Lower means this
   * Device pulled at least one row of this kind before the field that
   * bumped `currentEpoch` existed on the wire, and the fix is to reset
   * this stream's own Cursor to 0 and record `currentEpoch` as caught up
   * — in that order, so a process killed between the two still leaves a
   * Cursor of 0 and a stale recorded epoch, which repeats the reset
   * harmlessly on the next call rather than silently skipping it forever.
   * The reset costs one full re-walk of this stream, once: `getCursor()`
   * genuinely returns 0 afterward, and the ordinary, already-paginated
   * sync loop re-delivers every row this Device already holds exactly
   * once more, this time with whatever field it was missing. This is a
   * deliberate, narrow exception to CONTEXT.md's "a Cursor only ever
   * advances" — see that entry's own note on why a rewind here is
   * amended into the definition rather than quietly contradicting it.
   *
   * Equal or higher (including the common case: a Device that has never
   * synced this stream at all, which has never recorded any epoch and
   * has a Cursor already at 0) does nothing beyond one local `kv` read —
   * no Cursor touched, no second `kv` write, no query against a Server.
   * That is what keeps this free on every ordinary sync (this ticket's
   * own acceptance bar): the check that decides "nothing to do" costs a
   * single local integer comparison, not a network round trip.
   */
  catchUpRowShapeEpoch(currentEpoch: number): Promise<void>;
  /**
   * Issue #214 / ADR 0067: whether this Device has already run the
   * one-time newline-halving migration (`apps/web/src/lib/soft-break-migration.ts`)
   * at least once. Backed by `kv` (`SOFT_BREAK_MIGRATION_KEY`,
   * ./sqlite/schema.ts) rather than `localStorage`, so Restore — which
   * restores `kv` — carries this marker along with everything else; see
   * that key's own doc comment for why living there matters.
   *
   * This is an optimisation, not the source of correctness: the migration
   * itself is guarded per-row (`Entry.updatedAt` against
   * `protocol.ts`'s `BODY_SOFT_BREAK_CUTOFF`), so a Device that answers
   * `false` here when it has, in fact, already migrated every Entry it
   * holds simply re-scans once for nothing, cheaply and safely, rather
   * than corrupting anything. Callers use this the way
   * `hasAlreadyBackfilled` (`backfill-tasks.ts`'s own local equivalent for
   * ADR 0053's backfill) uses its own flag — to skip a redundant scan on
   * every ordinary open, not to decide whether a rewrite is safe.
   */
  hasCompletedSoftBreakMigration(): Promise<boolean>;
  /** Records that this Device has run the migration `hasCompletedSoftBreakMigration` reports on — see that method's own doc comment. */
  markSoftBreakMigrationComplete(): Promise<void>;
}
