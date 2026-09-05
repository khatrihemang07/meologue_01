import type { Entry } from "../types";

export function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    deviceId: "device-1",
    body: "hello meologue",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
