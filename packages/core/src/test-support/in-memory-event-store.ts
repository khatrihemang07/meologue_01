import type { EventStore } from "../event-store";
import type { Event } from "../event-types";

/**
 * A fake EventStore for exercising Todo's UI in tests — the Event-shaped
 * sibling of InMemoryCommentStore (./in-memory-comment-store.ts), mirroring
 * its structure method for method so the shared contract suite
 * (./event-store-contract.ts) sees the same behaviour from both this and
 * SqliteEventStore (../sqlite/sqlite-event-store.ts).
 */
export class InMemoryEventStore implements EventStore {
  private readonly rows = new Map<string, Event>();
  private cursor = 0;
  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for what this tracks.
  private rowShapeEpoch = 0;

  async list(): Promise<Event[]> {
    return [...this.rows.values()].sort(byOccurredThenId);
  }

  async listByTask(taskId: string): Promise<Event[]> {
    return [...this.rows.values()].filter((e) => e.taskId === taskId).sort(byOccurredThenId);
  }

  async listByProject(projectId: string | null): Promise<Event[]> {
    return [...this.rows.values()].filter((e) => e.projectId === projectId).sort(byOccurredThenId);
  }

  async record(event: Event): Promise<void> {
    if (!this.rows.has(event.id)) {
      this.rows.set(event.id, event);
    }
  }

  // Overwrites by id — see ../event-store.ts's own `upsert()` doc
  // comment for why (the echo of this Device's own pending push, once
  // confirmed, must land its real `seq` even though the row already
  // exists locally under this id).
  async upsert(events: Event[]): Promise<void> {
    for (const e of events) {
      this.rows.set(e.id, e);
    }
  }

  async pending(): Promise<Event[]> {
    return [...this.rows.values()].filter((e) => e.seq === null);
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
}

// Newest first, ties broken by id descending — mirrors
// EventStore.list()'s own doc comment.
function byOccurredThenId(a: Event, b: Event): number {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt < b.occurredAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
