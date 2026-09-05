import { DEFAULT_LABEL_COLOUR } from "../label-colors";
import type { Project, Section } from "../project-types";

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    deviceId: "device-1",
    name: "Errands",
    colour: DEFAULT_LABEL_COLOUR,
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function section(overrides: Partial<Section> = {}): Section {
  return {
    id: "section-1",
    deviceId: "device-1",
    projectId: "project-1",
    name: "Groceries",
    description: null,
    orderKey: "V",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
