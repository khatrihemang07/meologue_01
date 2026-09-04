import type { Event } from "../event-types";

export function event(overrides: Partial<Event> = {}): Event {
  return {
    id: "event-1",
    deviceId: "device-1",
    eventType: "added",
    objectType: "task",
    objectId: "task-1",
    taskId: "task-1",
    projectId: null,
    occurredAt: "2026-01-01T00:00:00.000Z",
    extra: null,
    seq: null,
    syncedAt: null,
    ...overrides,
  };
}
