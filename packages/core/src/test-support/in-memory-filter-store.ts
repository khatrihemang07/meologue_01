import {
  assertValidFilterColour,
  assertValidFilterName,
  assertValidFilterQuery,
  withDefaultFilterColour,
} from "../filter-fields";
import type { FilterStore } from "../filter-store";
import type { Filter } from "../filter-types";

/**
 * A fake FilterStore for exercising Todo's UI in tests — the Filter-shaped
 * sibling of InMemoryLabelStore (./in-memory-label-store.ts), mirroring
 * its structure method for method so the shared contract suite
 * (./filter-store-contract.ts) sees the same behaviour from both this and
 * SqliteFilterStore (../sqlite/sqlite-filter-store.ts).
 */
export class InMemoryFilterStore implements FilterStore {
  private readonly filters = new Map<string, Filter>();
  private cursor = 0;
  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for what this tracks.
  private rowShapeEpoch = 0;
  // Issue #196 — mirrors SqliteFilterStore's own identical field.
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  async list(): Promise<Filter[]> {
    return [...this.filters.values()]
      .filter((f) => f.deletedAt === null)
      .sort((a, b) => {
        const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return byName !== 0 ? byName : a.id.localeCompare(b.id);
      });
  }

  async get(id: string): Promise<Filter | undefined> {
    const existing = this.filters.get(id);
    return existing === undefined || existing.deletedAt !== null ? undefined : existing;
  }

  async upsert(newFilters: Filter[]): Promise<void> {
    for (const f of newFilters) {
      this.filters.set(f.id, withDefaultFilterColour(f));
    }
  }

  async rename(id: string, name: string): Promise<void> {
    assertValidFilterName(name);
    this.applyIfLive(id, { name, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  async setColour(id: string, colour: string): Promise<void> {
    assertValidFilterColour(colour);
    this.applyIfLive(id, { colour, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  async setQuery(id: string, query: string): Promise<void> {
    assertValidFilterQuery(query);
    this.applyIfLive(id, { query, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  async remove(id: string): Promise<void> {
    const existing = this.filters.get(id);
    if (existing === undefined) {
      return;
    }
    const deletedAt = this.now();
    this.filters.set(id, {
      ...existing,
      deletedAt,
      name: "",
      updatedAt: deletedAt,
      seq: null,
      syncedAt: null,
    });
  }

  async pending(): Promise<Filter[]> {
    return [...this.filters.values()].filter((f) => f.seq === null);
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

  // Mirrors InMemoryLabelStore.applyIfLive exactly.
  private applyIfLive(id: string, patch: Partial<Filter>): void {
    const existing = this.filters.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.filters.set(id, { ...existing, ...patch });
  }
}
