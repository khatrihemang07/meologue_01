import type { Comment } from "./comment-types";

/**
 * The Comment-shaped sibling of LabelStore (./label-store.ts) and
 * TaskStore (./task-store.ts) — mirrored section for section, exactly as
 * LabelStore's own header comment says it mirrors TaskStore, so a reader
 * who knows either recognises this one.
 *
 * **Deliberately carries no Sync wiring beyond the scaffolding
 * (`seq`/`syncedAt`/`pending`/`getCursor`/`setCursor`) that costs nothing
 * to have and everything to retrofit** — the identical reasoning
 * ./label-store.ts's own header comment gives, applied a second time:
 * issue #182 is the ticket that actually wires a Comment onto the wire
 * protocol.
 *
 * No `rename()`/`setColour()`-shaped setter pair the way LabelStore has:
 * a Comment has exactly one editable field, its own `text`, so this store
 * gets one setter — `edit()` — rather than a name mirroring a field that
 * doesn't exist here.
 *
 * **Removing a Task never reaches into this store.** TaskStore.remove()
 * tombstones the Task's own row and nothing else — see
 * ../comment-types.ts's own header comment for the full reasoning: a
 * cross-store cleanup write here would need the same non-atomic
 * multi-table write this codebase already refuses elsewhere (the
 * migrator has no transactions — ../sqlite/migrator.ts), and it costs
 * nothing to skip, because nothing in this app can open a view onto a
 * tombstoned Task's own Comments again. "Should not orphan its Comments
 * *visibly*" (issue #180's own acceptance criterion) is satisfied by
 * that unreachability, not by a cascade.
 */
export interface CommentStore {
  /**
   * Every live Comment across every Task, oldest first (`createdAt`
   * ascending, ties broken by id) — the global feed Todo's own row
   * (apps/web's task-row.tsx) reads to compute a comment count per Task,
   * mirroring TaskStore.list()'s own role as "the global feed every
   * cross-view depends on" (../task-store.ts's own doc comment). Loaded
   * wholesale, not paginated: a personal task list's own Comments sit at
   * the scale Labels and Tasks themselves already do, not History's
   * scale — ADR 0016's own reasoning for why *that* list() gained an
   * optional page argument and this one doesn't.
   */
  list(): Promise<Comment[]>;
  /**
   * One Task's own thread, oldest first, same order as list() above —
   * the scoped read the Task detail view actually renders, mirroring
   * TaskStore.listByProject's own "list() is the global feed, this is
   * the scoped read a caller with one specific Task in mind wants
   * instead" split (../task-store.ts's own doc comment).
   */
  listByTask(taskId: string): Promise<Comment[]>;
  /** One Comment by id, or undefined if unknown or tombstoned. */
  get(id: string): Promise<Comment | undefined>;
  /**
   * Sync's write path, and a new Comment's own: upsert wholesale, exactly
   * as every other store's upsert() does — there is deliberately no
   * `add()`, the same "one door, local creation and a future Sync round
   * trip both use" rule LabelStore.upsert's own doc comment states.
   */
  upsert(comments: Comment[]): Promise<void>;
  /**
   * Changes `text` and clears `seq` — mirrors LabelStore.rename's own doc
   * comment for why this is its own method rather than upsert() with a
   * mutated Comment: a caller building its own patch object has no way
   * to know it must no-op against a tombstone. Left as the one seam
   * issue #184's activity log needs — "editing a Comment records an
   * event, diverging from Todoist" (issue #180's own reference-behaviour
   * note) — without this ticket building that log itself. No-op against
   * a tombstone.
   */
  edit(id: string, text: string): Promise<void>;
  /**
   * Tombstone, never a hard delete (ADR 0028's rule, applied a fourth
   * time). Blanks `text` for the identical reason LabelStore.remove()
   * blanks `name` and SqliteTaskStore.remove() blanks `content`: a
   * tombstone that still carried its old words would assert "removed"
   * and "still says X" about the same row at once.
   */
  remove(id: string): Promise<void>;
  /** Comments with no sequence number, tombstones included — exactly `seq IS NULL`, mirroring every other store's pending(). */
  pending(): Promise<Comment[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  /**
   * Issue #186 / ADR 0057 — see `EntryStore.catchUpRowShapeEpoch`'s own
   * doc comment (./store.ts) for the mechanism; `currentEpoch` here is
   * `protocol.ts`'s `ROW_SHAPE_EPOCH.comments`.
   */
  catchUpRowShapeEpoch(currentEpoch: number): Promise<void>;
  /**
   * Substring search over every live Comment's own `text` (issue #183) —
   * the identical matching rules TaskStore.search's own doc comment gives
   * for a Task's title/Description, shared via ../task-search.ts rather
   * than reimplemented: case-insensitive, diacritic-folded, every
   * whitespace-separated word of the query has to appear somewhere in the
   * text, in any order, punctuation matched literally. Unlike TaskStore,
   * there's no FTS5 index behind this and no whole-word/completed mode to
   * opt into — a Comment carries no completion state of its own to
   * exclude, and this store's own list()'s doc comment already
   * establishes that a personal task list's Comments sit at a scale where
   * scanning every one of them, the way this reuses list() to do, doesn't
   * matter in practice; standing up a second hand-maintained FTS5 index
   * for data already scanned wholesale elsewhere would be machinery this
   * app's own scale doesn't ask for (CLAUDE.md's v0.1 scope discipline).
   * Ordered oldest-first, list()'s own order — the same "creation order,
   * no relevance re-ranking" finding TaskStore.search's own doc comment
   * describes. An empty or whitespace-only query matches nothing.
   */
  search(query: string): Promise<Comment[]>;
}
