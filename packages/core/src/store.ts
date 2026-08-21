import type { Entry } from "./types";

export interface EntryStore {
  list(): Promise<Entry[]>;
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
