import type { EntryPage, EntryStore } from "../store";
import type { Entry } from "../types";

/**
 * A fake EntryStore for exercising the sync engine in tests. The real,
 * platform-specific implementation (behind the same EntryStore interface,
 * per ADR 0001) lands in a later ticket.
 */
export class InMemoryEntryStore implements EntryStore {
  private readonly entries = new Map<string, Entry>();
  private cursor = 0;
  // Issue #186 / ADR 0057: mirrors ROW_SHAPE_EPOCH_KEY's persisted value
  // in the real SqliteEntryStore — see EntryStore.catchUpRowShapeEpoch's
  // own doc comment (../store.ts) for what this tracks and why.
  private rowShapeEpoch = 0;

  async list(page?: EntryPage): Promise<Entry[]> {
    // Excludes tombstones (ADR 0028) — mirrors SqliteEntryStore.list()'s
    // `deleted_at IS NULL` filter, since the shared contract suite
    // (../test-support/entry-store-contract.ts) has to see the same
    // behaviour from both implementations.
    const all = [...this.entries.values()]
      .filter((entry) => entry.deletedAt === null)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt < b.createdAt ? 1 : -1;
        }
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      });
    // `before` narrowed to a local const so it stays narrowed inside the
    // filter callback below — mirrors SqliteEntryStore.list()'s WHERE:
    // strictly older than the cursor in this same (createdAt desc, id
    // desc) order, an OR of "smaller createdAt" and "same createdAt, smaller
    // id" rather than a single comparison, because of the tie-break.
    const before = page?.before;
    const filtered = before === undefined ? all : all.filter((entry) => isOlderThan(entry, before));
    return page?.limit === undefined ? filtered : filtered.slice(0, page.limit);
  }

  /**
   * Mirrors SqliteEntryStore.getMany() — see EntryStore.getMany's doc
   * comment for the contract both implementations owe callers. No
   * chunking needed here: unlike a real SQLite statement, a JS `Set`
   * lookup has no bound-parameter limit to respect.
   */
  async getMany(ids: string[]): Promise<Entry[]> {
    if (ids.length === 0) {
      return [];
    }
    const wanted = new Set(ids);
    return [...this.entries.values()].filter(
      (entry) => wanted.has(entry.id) && entry.deletedAt === null,
    );
  }

  async upsert(entries: Entry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  async pending(): Promise<Entry[]> {
    // Tombstones awaiting push have `seq === null` exactly like a newly
    // captured Entry (ADR 0028), so they're picked up here with no
    // special-casing — mirrors SqliteEntryStore.pending()'s comment.
    return [...this.entries.values()].filter((entry) => entry.seq === null);
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

  async search(query: string): Promise<Entry[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }
    const all = await this.list();
    return all.filter((entry) => matchesPrefixPhrase(tokenize(entry.body), queryTokens));
  }

  /**
   * Mirrors SqliteEntryStore.edit() — see EntryStore.edit's doc comment
   * for the invariants both implementations owe callers, and the real
   * store for why clearing `seq` is what pushes the edit rather than a
   * side effect of something else.
   */
  async edit(id: string, body: string): Promise<void> {
    const existing = this.entries.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      // Unknown id, or already a tombstone — mirrors the real store's
      // `WHERE deleted_at IS NULL` guard (ADR 0028) so a stale local edit
      // can never resurrect an Entry deleted elsewhere.
      return;
    }
    this.entries.set(id, { ...existing, body, seq: null, syncedAt: null });
  }

  /**
   * Mirrors SqliteEntryStore.remove() — see EntryStore.remove's doc
   * comment for the invariants both implementations owe callers,
   * including the resurrection trap a hard delete here would reopen.
   */
  async remove(id: string): Promise<void> {
    const existing = this.entries.get(id);
    if (existing === undefined) {
      return;
    }
    this.entries.set(id, {
      ...existing,
      deletedAt: new Date().toISOString(),
      body: "",
      seq: null,
      syncedAt: null,
    });
  }
}

// Whether `entry` is strictly older than `cursor` in list()'s own order
// (createdAt desc, then id desc) — used by list()'s `before` paging above.
// Kept as its own function, not inlined into the filter callback, so its
// two-part "earlier createdAt, or same createdAt with a smaller id" logic
// reads the same way SqliteEntryStore.list()'s SQL WHERE does, rather than
// as an easy-to-misread ternary inside a .filter().
function isOlderThan(entry: Entry, cursor: { createdAt: string; id: string }): boolean {
  if (entry.createdAt !== cursor.createdAt) {
    return entry.createdAt < cursor.createdAt;
  }
  return entry.id < cursor.id;
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
