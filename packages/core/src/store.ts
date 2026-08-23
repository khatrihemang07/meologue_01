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
  upsert(entries: Entry[]): Promise<void>;
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
}
