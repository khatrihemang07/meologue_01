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
    // No Labels — the same "concrete value, not a gap" default every
    // pre-#170 row gets from the migration (../sqlite/schema.ts).
    labelIds: [],
    // Doesn't repeat — ../recurrence/'s engine is never invoked for a
    // fixture Task unless a test overrides this explicitly.
    dateString: null,
    // In Inbox, no Section, top-level — the same "nothing chosen yet"
    // state every other #171 field above defaults to, and what a Task
    // created directly in Todo starts with (../task-types.ts).
    projectId: null,
    sectionId: null,
    parentId: null,
    ...overrides,
  };
}
