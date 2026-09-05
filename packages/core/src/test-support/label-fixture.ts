import { DEFAULT_LABEL_COLOUR } from "../label-colors";
import type { Label } from "../label-types";

export function label(overrides: Partial<Label> = {}): Label {
  return {
    id: "label-1",
    deviceId: "device-1",
    name: "errand",
    colour: DEFAULT_LABEL_COLOUR,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
