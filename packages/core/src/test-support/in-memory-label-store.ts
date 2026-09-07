import {
  assertValidLabelColour,
  assertValidLabelName,
  withDefaultLabelColour,
} from "../label-fields";
import type { LabelStore } from "../label-store";
import type { Label } from "../label-types";
import { isAtLeastAsNewAs } from "../updated-at";

/**
 * A fake LabelStore for exercising Todo's UI in tests — the Label-shaped
 * sibling of InMemoryTaskStore (./in-memory-task-store.ts), mirroring its
 * structure method for method so the shared contract suite
 * (./label-store-contract.ts) sees the same behaviour from both this and
 * SqliteLabelStore (../sqlite/sqlite-label-store.ts).
 */
export class InMemoryLabelStore implements LabelStore {
  private readonly labels = new Map<string, Label>();
  private cursor = 0;
  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for what this tracks.
  private rowShapeEpoch = 0;
  // Issue #196 — mirrors SqliteLabelStore's own identical field.
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  async list(): Promise<Label[]> {
    return [...this.labels.values()]
      .filter((l) => l.deletedAt === null)
      .sort((a, b) => {
        const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return byName !== 0 ? byName : a.id.localeCompare(b.id);
      });
  }

  async get(id: string): Promise<Label | undefined> {
    const existing = this.labels.get(id);
    return existing === undefined || existing.deletedAt !== null ? undefined : existing;
  }

  async upsert(newLabels: Label[]): Promise<void> {
    for (const l of newLabels) {
      this.labels.set(l.id, withDefaultLabelColour(l));
    }
  }

  /**
   * Mirrors SqliteLabelStore.applyPulled() (issue #218) — see
   * LabelStore.applyPulled's own doc comment (../label-store.ts) for the
   * rule, and InMemoryEntryStore.applyPulled's own comment (./in-memory-
   * entry-store.ts) for why this is written as "apply unless," the same
   * shape the SQL guard is in.
   */
  async applyPulled(incoming: Label[]): Promise<void> {
    for (const raw of incoming) {
      const entry = withDefaultLabelColour(raw);
      const local = this.labels.get(entry.id);
      const incomingIsAtLeastAsNew =
        local !== undefined && isAtLeastAsNewAs(entry.updatedAt, local.updatedAt);
      const apply =
        local === undefined ||
        local.seq !== null ||
        incomingIsAtLeastAsNew ||
        entry.deletedAt !== null;
      if (apply) {
        this.labels.set(entry.id, entry);
      }
    }
  }

  async rename(id: string, name: string): Promise<void> {
    assertValidLabelName(name);
    this.applyIfLive(id, { name, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  async setColour(id: string, colour: string): Promise<void> {
    assertValidLabelColour(colour);
    this.applyIfLive(id, { colour, updatedAt: this.now(), seq: null, syncedAt: null });
  }

  async remove(id: string): Promise<void> {
    const existing = this.labels.get(id);
    if (existing === undefined) {
      return;
    }
    const deletedAt = this.now();
    this.labels.set(id, {
      ...existing,
      deletedAt,
      name: "",
      updatedAt: deletedAt,
      seq: null,
      syncedAt: null,
    });
  }

  async pending(): Promise<Label[]> {
    return [...this.labels.values()].filter((l) => l.seq === null);
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

  // Mirrors InMemoryTaskStore.applyIfLive exactly.
  private applyIfLive(id: string, patch: Partial<Label>): void {
    const existing = this.labels.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.labels.set(id, { ...existing, ...patch });
  }
}
