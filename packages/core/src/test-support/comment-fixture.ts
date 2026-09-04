import type { Comment } from "../comment-types";

export function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "comment-1",
    deviceId: "device-1",
    taskId: "task-1",
    text: "sounds good",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
