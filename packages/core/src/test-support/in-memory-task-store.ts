import { withDefaultLabelIds } from "../label-fields";
import { compareByOrder } from "../order-key";
import { nextOccurrenceAfterCompletion, tomorrowOf } from "../recurrence";
import {
  assertValidDate,
  assertValidDeadline,
  assertValidNestingDepth,
  assertValidPriority,
  hasTime,
  withDefaultDateString,
  withDefaultDayOrder,
  withDefaultDescription,
  withDefaultSchedulingFields,
  withDefaultStructureFields,
} from "../task-fields";
import { matchesSubstring, matchesWholeWord } from "../task-search";
import type { TaskSearchOptions, TaskStore } from "../task-store";
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
  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for what this tracks.
  private rowShapeEpoch = 0;

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

  // Mirrors SqliteTaskStore.listByProject — see TaskStore.listByProject's
  // own doc comment for why this stays a separate query rather than
  // narrowing list() above.
  async listByProject(projectId: string | null): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter(
        (t) =>
          t.completedAt === null &&
          t.deletedAt === null &&
          t.parentId === null &&
          t.projectId === projectId,
      )
      .sort(compareByOrder);
  }

  // Mirrors SqliteTaskStore.listChildren.
  async listChildren(parentId: string): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((t) => t.completedAt === null && t.deletedAt === null && t.parentId === parentId)
      .sort(compareByOrder);
  }

  // Mirrors SqliteTaskStore.listInSection — active and completed both
  // included, see TaskStore.listInSection's own doc comment for why.
  async listInSection(sectionId: string): Promise<Task[]> {
    return [...this.tasks.values()].filter(
      (t) => t.deletedAt === null && t.sectionId === sectionId,
    );
  }

  // Mirrors SqliteTaskStore.listDescendants — a breadth-first walk down
  // `parentId`, bounded by the nesting cap (see TaskStore.listDescendants'
  // own doc comment).
  async listDescendants(id: string): Promise<Task[]> {
    const descendants: Task[] = [];
    let frontier = [id];
    while (frontier.length > 0) {
      const children = [...this.tasks.values()].filter(
        (t) => t.deletedAt === null && t.parentId !== null && frontier.includes(t.parentId),
      );
      descendants.push(...children);
      frontier = children.map((c) => c.id);
    }
    return descendants;
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
    // withDefaultSchedulingFields — see SqliteTaskStore.upsert's identical
    // call for why: a caller that omits date/deadline/priority
    // (Task.priority's own doc comment on why that key is TS-optional)
    // must not leave this store holding a Task whose priority is actually
    // `undefined`, which would silently break every reader that treats
    // Task.priority as always concretely present.
    for (const t of tasks) {
      this.tasks.set(
        t.id,
        withDefaultDayOrder(
          withDefaultDescription(
            withDefaultStructureFields(
              withDefaultDateString(withDefaultLabelIds(withDefaultSchedulingFields(t))),
            ),
          ),
        ),
      );
    }
  }

  async complete(id: string, completedAt: string): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.applyIfLive(id, { completedAt, seq: null, syncedAt: null });
    await this.completeChildren(id, completedAt);
  }

  // Completing a parent completes its sub-tasks along with it
  // (TaskStore.complete's own doc comment) — recurses through complete()
  // itself, not a flat loop, so a grandchild is reached too, bounded by
  // the four-level nesting cap. Only active children are touched — see
  // that same doc comment for why an already-completed child's own
  // `completedAt` must not be overwritten.
  private async completeChildren(parentId: string, completedAt: string): Promise<void> {
    const children = await this.listChildren(parentId);
    for (const child of children) {
      await this.complete(child.id, completedAt);
    }
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

  /** Mirrors SqliteTaskStore.reorderToday() — see TaskStore.reorderToday's own doc comment. */
  async reorderToday(id: string, dayOrder: string): Promise<void> {
    this.applyIfLive(id, { dayOrder, seq: null, syncedAt: null });
  }

  async setDate(id: string, date: string | null): Promise<void> {
    assertValidDate(date);
    this.applyIfLive(id, { date, seq: null, syncedAt: null });
  }

  async setDeadline(id: string, deadline: string | null): Promise<void> {
    assertValidDeadline(deadline);
    this.applyIfLive(id, { deadline, seq: null, syncedAt: null });
  }

  async setPriority(id: string, priority: number): Promise<void> {
    assertValidPriority(priority);
    this.applyIfLive(id, { priority, seq: null, syncedAt: null });
  }

  // Mirrors SqliteTaskStore.setLabelIds — see TaskStore.setLabelIds's own
  // doc comment for why this replaces the array wholesale.
  async setLabelIds(id: string, labelIds: string[]): Promise<void> {
    this.applyIfLive(id, { labelIds, seq: null, syncedAt: null });
  }

  // Mirrors SqliteTaskStore.setDescription — see TaskStore.setDescription's own doc comment.
  async setDescription(id: string, description: string | null): Promise<void> {
    this.applyIfLive(id, { description, seq: null, syncedAt: null });
  }

  // Mirrors SqliteTaskStore.setProject — see TaskStore.setProject's own
  // doc comment for why `sectionId` is cleared unconditionally alongside
  // `projectId`.
  async setProject(id: string, projectId: string | null): Promise<void> {
    this.applyIfLive(id, { projectId, sectionId: null, seq: null, syncedAt: null });
  }

  async setSection(id: string, sectionId: string | null): Promise<void> {
    this.applyIfLive(id, { sectionId, seq: null, syncedAt: null });
  }

  // Mirrors SqliteTaskStore.setParent — see TaskStore.setParent's own doc
  // comment for the three shapes this refuses. Reads the target Task
  // first, the same as complete/advanceRecurring above: "no-op against
  // a tombstone" for `id` itself is unconditional, checked before any of
  // `parentId`'s own validation runs.
  async setParent(id: string, parentId: string | null): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    if (parentId !== null) {
      if (parentId === id) {
        throw new Error(`Task ${id} cannot be its own parent`);
      }
      let cursor = this.tasks.get(parentId);
      if (cursor === undefined || cursor.deletedAt !== null) {
        throw new Error(`setParent: parent Task ${parentId} does not exist or is tombstoned`);
      }
      // depth starts at 1 — `parentId`'s own depth (1 = top-level) — and
      // this walk both counts it and, by checking for `id` along the way,
      // catches a cycle: `parentId` can only be a legal target if `id`
      // is not already one of its own ancestors.
      let depth = 1;
      const visited = new Set<string>([parentId]);
      while (cursor.parentId !== null) {
        if (cursor.parentId === id) {
          throw new Error(
            `setParent: Task ${id} is already an ancestor of ${parentId} — this would create a cycle`,
          );
        }
        if (visited.has(cursor.parentId)) {
          throw new Error(
            `setParent: ${parentId}'s own ancestor chain already cycles at ${cursor.parentId}`,
          );
        }
        visited.add(cursor.parentId);
        const next = this.tasks.get(cursor.parentId);
        if (next === undefined) {
          break;
        }
        cursor = next;
        depth++;
      }
      assertValidNestingDepth(depth);
    }
    this.applyIfLive(id, { parentId, seq: null, syncedAt: null });
  }

  // Mirrors SqliteTaskStore.advanceRecurring — see TaskStore.advanceRecurring's
  // own doc comment for the full reasoning. "No-op against a tombstone"
  // is checked here the same way setParent's own no-op check is: before
  // either throw below becomes reachable.
  async advanceRecurring(id: string, completedAt: string): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    if (existing.dateString === null || existing.dateString === undefined) {
      throw new Error(
        `advanceRecurring called on Task ${id}, which has no recurrence (dateString is null)`,
      );
    }
    const now = completedAt.slice(0, 10);
    const outcome = nextOccurrenceAfterCompletion(existing.dateString, {
      dueDate: existing.date,
      now,
    });
    if (outcome.kind === "refused") {
      throw new Error(
        `Task ${id}'s stored recurrence "${existing.dateString}" no longer parses: ${outcome.reason}`,
      );
    }
    if (outcome.kind === "ended") {
      // A bounded rule that's run out *is* an ordinary completed Task from
      // here on (TaskStore.advanceRecurring's own doc comment) — cascades
      // to active sub-tasks exactly as complete()/completeForever() do,
      // for the identical reason.
      this.applyIfLive(id, { completedAt, dateString: null, seq: null, syncedAt: null });
      await this.completeChildren(id, completedAt);
      return;
    }
    // `completedAt` is deliberately absent — a recurring Task never
    // enters the completed list; only `date` moves.
    this.applyIfLive(id, { date: outcome.date, seq: null, syncedAt: null });
  }

  // Mirrors SqliteTaskStore.completeForever — see TaskStore.completeForever's own doc comment.
  // Reads the Task first, like complete() above, so the cascade below
  // only runs when this actually completed a live Task — not when
  // applyIfLive silently no-opped against a tombstone.
  async completeForever(id: string, completedAt: string): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing === undefined || existing.deletedAt !== null) {
      return;
    }
    this.applyIfLive(id, { completedAt, dateString: null, seq: null, syncedAt: null });
    await this.completeChildren(id, completedAt);
  }

  // Mirrors SqliteTaskStore.postpone — see TaskStore.postpone's own doc
  // comment. Reads the Task first, the same as setParent/
  // advanceRecurring above, to know whether `date` carries a time-of-day
  // to preserve on the new day.
  async postpone(id: string, today: string): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing === undefined || existing.deletedAt !== null || existing.date === null) {
      return;
    }
    const tomorrow = tomorrowOf(today);
    const nextDate = hasTime(existing.date)
      ? `${tomorrow}T${existing.date.slice(11, 16)}`
      : tomorrow;
    this.applyIfLive(id, { date: nextDate, seq: null, syncedAt: null });
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

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for the mechanism this mirrors.
  async catchUpRowShapeEpoch(currentEpoch: number): Promise<void> {
    if (this.rowShapeEpoch >= currentEpoch) {
      return;
    }
    this.cursor = 0;
    this.rowShapeEpoch = currentEpoch;
  }

  // Mirrors SqliteTaskStore.search — see TaskStore.search's own doc
  // comment for the full matching rules (issue #183) and
  // ../task-search.ts for the shared matchers this and the SQLite store
  // both call, so the two can't drift on what "matches" means. Unlike
  // SqliteTaskStore, there's no FTS5 here to fast-path: this store is a
  // plain JS scan regardless of query length, which is exactly what
  // SqliteTaskStore's own JS fallback path already is for a query FTS5's
  // trigram tokenizer can't see.
  async search(query: string, options?: TaskSearchOptions): Promise<Task[]> {
    const trimmed = query.trim();
    if (trimmed === "") {
      return [];
    }
    const fields = options?.fields ?? (["title", "description"] as const);
    const includeCompleted = options?.includeCompleted ?? false;
    const matcher = includeCompleted ? matchesWholeWord : matchesSubstring;
    const candidates = [...this.tasks.values()].filter(
      (t) => t.deletedAt === null && (includeCompleted || t.completedAt === null),
    );
    return candidates
      .filter((t) =>
        fields.some((field) => matcher(field === "title" ? t.content : t.description, trimmed)),
      )
      .sort(byCreatedThenId);
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

// Creation order — search()'s own ordering (TaskStore.search's doc
// comment, issue #183), distinct from list()'s manual compareByOrder.
// Task ids are time-ordered uuidv7 (../id.ts), so the id tie-break orders
// a same-millisecond pair the same way createdAt itself would if it had
// finer resolution — mirrors listCompleted()'s own tie-break above, just
// ascending instead of descending.
function byCreatedThenId(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
