import { compareByOrder } from "../order-key";
import type { TaskStore } from "../task-store";
import type { Task } from "../task-types";

/**
 * A fake TaskStore for exercising the sync engine and Todo's UI in tests —
 * the Task-shaped sibling of InMemoryEntryStore (./in-memory-entry-store.ts),
 * mirroring its structure method for method so the shared contract suite
 * (./task-store-contract.ts) sees the same behaviour from both this and
 * SqliteTaskStore (../sqlite/sqlite-task-store.ts).
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private cursor = 0;

  async list(): Promise<Task[]> {
    // Active: not completed, not tombstoned — mirrors
    // SqliteTaskStore.list()'s WHERE, then sorted with the exact
    // comparator every Device applies (../order-key.ts's compareByOrder),
    // so this store can't silently drift from the client-side ordering
    // rule that comparator exists to pin down.
    return [...this.tasks.values()]
      .filter((t) => t.completedAt === null && t.deletedAt === null)
      .sort(compareByOrder);
  }

  async listCompleted(): Promise<Task[]> {
    // Newest completion first, ties broken by id descending — mirrors
    // EntryStore.list()'s createdAt-desc/id-desc tie-break reasoning:
    // Task ids are time-ordered uuidv7 (../id.ts), so an ascending
    // tie-break would order same-millisecond completions oldest-first
    // inside an otherwise newest-first list.
    return [...this.tasks.values()]
      .filter((t) => t.completedAt !== null && t.deletedAt === null)
      .sort((a, b) => {
        const aCompleted = a.completedAt as string;
        const bCompleted = b.completedAt as string;
        if (aCompleted !== bCompleted) {
          return aCompleted < bCompleted ? 1 : -1;
        }
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      });
  }

  async get(id: string): Promise<Task | undefined> {
    const existing = this.tasks.get(id);
    return existing === undefined || existing.deletedAt !== null ? undefined : existing;
  }

  async upsert(tasks: Task[]): Promise<void> {
    for (const t of tasks) {
      this.tasks.set(t.id, t);
    }
  }

  async complete(id: string, completedAt: string): Promise<void> {
    this.applyIfLive(id, { completedAt, seq: null, syncedAt: null });
  }

  async uncomplete(id: string): Promise<void> {
    this.applyIfLive(id, { completedAt: null, seq: null, syncedAt: null });
  }

  async rename(id: string, content: string): Promise<void> {
    this.applyIfLive(id, { content, seq: null, syncedAt: null });
  }

  /**
   * Mirrors SqliteTaskStore.reorder() — a single Map.set on this Task's
   * own entry, touching nothing else. That's what "writes exactly one
   * row" (TaskStore.reorder's doc comment) means in a store that has no
   * rows at all: every sibling's Task object is left untouched, not
   * merely unread.
   */
  async reorder(id: string, orderKey: string): Promise<void> {
    this.applyIfLive(id, { orderKey, seq: null, syncedAt: null });
  }

  /**
   * Mirrors SqliteEntryStore.remove() — see TaskStore.remove's doc
   * comment for the resurrection trap this guards against by never
   * hard-deleting, `seq` or no `seq`.
   */
  async remove(id: string): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing === undefined) {
      return;
    }
    this.tasks.set(id, {
      ...existing,
      deletedAt: new Date().toISOString(),
      content: "",
      seq: null,
      syncedAt: null,
    });
  }

  async pending(): Promise<Task[]> {
    // Tombstones awaiting push have seq === null exactly like a newly
    // created Task (ADR 0028's Decision, applied to Tasks) — no
    // tombstone-specific branch needed to pick them up.
    return [...this.tasks.values()].filter((t) => t.seq === null);
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(seq: number): Promise<void> {
    this.cursor = seq;
  }

  async search(query: string): Promise<Task[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }
    // Completed and tombstoned Tasks are both excluded — see
    // TaskStore.search's doc comment for why a completed Task doesn't
    // belong in "find something I still need to act on."
    const candidates = [...this.tasks.values()].filter(
      (t) => t.completedAt === null && t.deletedAt === null,
    );
    return candidates
      .filter((t) => matchesPrefixPhrase(tokenize(t.content), queryTokens))
      .sort(compareByOrder);
  }

  // A local mutation against an unknown or already-tombstoned id is a
  // no-op — mirrors every guarded write in InMemoryEntryStore
  // (./in-memory-entry-store.ts): a caller can't tell "this id never
  // existed" apart from "this id was deleted elsewhere," and the store
  // must not resurrect either way.
  private applyIfLive(id: string, patch: Partial<Task>): void {
    const existing = this.tasks.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.tasks.set(id, { ...existing, ...patch });
  }
}

// Mirrors the SQLite store's FTS5 unicode61 tokenizer closely enough for
// the shared contract to assert the same behaviour against both — see
// ./in-memory-entry-store.ts's identical pair of helpers, duplicated
// rather than shared, for the same reason that file's tokenizer isn't
// exported: it's a small, store-local mirror of SQLite's own tokenizer,
// not a shared implementation the two stores both depend on.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function matchesPrefixPhrase(bodyTokens: string[], queryTokens: string[]): boolean {
  const lastQueryToken = queryTokens.length - 1;
  for (let start = 0; start <= bodyTokens.length - queryTokens.length; start++) {
    const window = bodyTokens.slice(start, start + queryTokens.length);
    const matchesHere = queryTokens.every((queryToken, offset) =>
      offset === lastQueryToken
        ? window[offset]?.startsWith(queryToken)
        : window[offset] === queryToken,
    );
    if (matchesHere) {
      return true;
    }
  }
  return false;
}
