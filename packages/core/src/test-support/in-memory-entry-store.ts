import type { EntryStore } from "../store";
import type { Entry } from "../types";

/**
 * A fake EntryStore for exercising the sync engine in tests. The real,
 * platform-specific implementation (behind the same EntryStore interface,
 * per ADR 0001) lands in a later ticket.
 */
export class InMemoryEntryStore implements EntryStore {
  private readonly entries = new Map<string, Entry>();
  private cursor = 0;

  async list(): Promise<Entry[]> {
    return [...this.entries.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  async upsert(entries: Entry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  async pending(): Promise<Entry[]> {
    return [...this.entries.values()].filter((entry) => entry.seq === null);
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(seq: number): Promise<void> {
    this.cursor = seq;
  }
}
