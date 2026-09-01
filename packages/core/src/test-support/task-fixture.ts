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
    ...overrides,
  };
}
