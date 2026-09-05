import { assertValidCommentText } from "../comment-fields";
import type { CommentStore } from "../comment-store";
import type { Comment } from "../comment-types";
import { matchesSubstring } from "../task-search";

/**
 * A fake CommentStore for exercising Todo's UI in tests — the
 * Comment-shaped sibling of InMemoryLabelStore (./in-memory-label-store.ts),
 * mirroring its structure method for method so the shared contract suite
 * (./comment-store-contract.ts) sees the same behaviour from both this and
 * SqliteCommentStore (../sqlite/sqlite-comment-store.ts).
 */
export class InMemoryCommentStore implements CommentStore {
  private readonly comments = new Map<string, Comment>();
  private cursor = 0;
  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for what this tracks.
  private rowShapeEpoch = 0;
  // Issue #196 — mirrors SqliteCommentStore's own identical field.
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  async list(): Promise<Comment[]> {
    return [...this.comments.values()].filter((c) => c.deletedAt === null).sort(byCreatedThenId);
  }

  async listByTask(taskId: string): Promise<Comment[]> {
    return [...this.comments.values()]
      .filter((c) => c.deletedAt === null && c.taskId === taskId)
      .sort(byCreatedThenId);
  }

  async get(id: string): Promise<Comment | undefined> {
    const existing = this.comments.get(id);
    return existing === undefined || existing.deletedAt !== null ? undefined : existing;
  }

  async upsert(newComments: Comment[]): Promise<void> {
    for (const c of newComments) {
      this.comments.set(c.id, c);
    }
  }

  async edit(id: string, text: string): Promise<void> {
    assertValidCommentText(text);
    this.applyIfLive(id, { text, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  async remove(id: string): Promise<void> {
    const existing = this.comments.get(id);
    if (existing === undefined) {
      return;
    }
    const deletedAt = this.now();
    this.comments.set(id, {
      ...existing,
      deletedAt,
      text: "",
      updatedAt: deletedAt,
      seq: null,
      syncedAt: null,
    });
  }

  async pending(): Promise<Comment[]> {
    return [...this.comments.values()].filter((c) => c.seq === null);
  }

  // Mirrors SqliteCommentStore.search — see CommentStore.search's own doc comment.
  async search(query: string): Promise<Comment[]> {
    if (query.trim() === "") {
      return [];
    }
    const all = await this.list();
    return all.filter((c) => matchesSubstring(c.text, query));
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(seq: number): Promise<void> {
    this.cursor = seq;
  }

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for the mechanism this mirrors.
  async catchUpRowShapeEpoch(currentEpoch: number): Promise<void> {
    if (this.rowShapeEpoch >= currentEpoch) {
      return;
    }
    this.cursor = 0;
    this.rowShapeEpoch = currentEpoch;
  }

  // Mirrors InMemoryLabelStore.applyIfLive/InMemoryTaskStore.applyIfLive exactly.
  private applyIfLive(id: string, patch: Partial<Comment>): void {
    const existing = this.comments.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.comments.set(id, { ...existing, ...patch });
  }
}

function byCreatedThenId(a: Comment, b: Comment): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
