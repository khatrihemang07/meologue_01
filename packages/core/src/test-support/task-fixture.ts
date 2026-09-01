import type { Task } from "../task-types";

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    deviceId: "device-1",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    // Undated, no deadline, no duration, priority 1 ("no priority",
    // ../task-types.ts's uiPriorityOf/storedPriorityOf) — the same state
    // a Task created directly in Todo starts in, and the migration
    // default every pre-#169 row got (../sqlite/schema.ts).
    date: null,
    deadline: null,
    duration: null,
    priority: 1,
    ...overrides,
  };
}
