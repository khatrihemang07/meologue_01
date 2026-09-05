import type { Filter } from "../filter-types";
import { DEFAULT_LABEL_COLOUR } from "../label-colors";

export function filter(overrides: Partial<Filter> = {}): Filter {
  return {
    id: "filter-1",
    deviceId: "device-1",
    name: "Due today",
    colour: DEFAULT_LABEL_COLOUR,
    query: "today",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
