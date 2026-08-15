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
      return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
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

  async search(query: string): Promise<Entry[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }
    const all = await this.list();
    return all.filter((entry) => matchesPrefixPhrase(tokenize(entry.body), queryTokens));
  }
}

// Mirrors the SQLite store's FTS5 unicode61 tokenizer closely enough for
// the shared contract (../test-support/entry-store-contract.ts) to assert
// the same behaviour against both: split on anything that isn't a letter
// or digit, case-fold the rest.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

// Mirrors FTS5's quoted-phrase-with-trailing-`*` semantics (ADR 0014): the
// query's tokens must appear in the body, contiguous and in order, with
// only the last one matching as a prefix rather than exactly.
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
