import type { Entry, EntryStore } from "@meologue/core";

const ENTRIES_KEY = "meologue:entries";
const CURSOR_KEY = "meologue:cursor";

/**
 * The browser-local EntryStore (ADR 0001) — persistence backed by localStorage,
 * standing in for SQLite until the real embedded store lands.
 */
export class LocalEntryStore implements EntryStore {
  async list(): Promise<Entry[]> {
    return sortByCreatedAt(readEntries());
  }

  async upsert(entries: Entry[]): Promise<void> {
    const byId = new Map(readEntries().map((existing) => [existing.id, existing]));
    for (const entry of entries) {
      byId.set(entry.id, entry);
    }
    writeEntries([...byId.values()]);
  }

  async pending(): Promise<Entry[]> {
    return readEntries().filter((entry) => entry.seq === null);
  }

  async getCursor(): Promise<number> {
    const raw = localStorage.getItem(CURSOR_KEY);
    return raw === null ? 0 : Number(raw);
  }

  async setCursor(seq: number): Promise<void> {
    localStorage.setItem(CURSOR_KEY, String(seq));
  }
}

function readEntries(): Entry[] {
  const raw = localStorage.getItem(ENTRIES_KEY);
  return raw === null ? [] : (JSON.parse(raw) as Entry[]);
}

function writeEntries(entries: Entry[]): void {
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
}

function sortByCreatedAt(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
