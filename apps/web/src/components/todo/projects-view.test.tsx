import type { Project } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { depthOf, ProjectsView } from "./projects-view";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    deviceId: "device-a",
    name: "Groceries",
    colour: "#DC4C3E",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "A",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function renderProjectsView(overrides: Partial<Parameters<typeof ProjectsView>[0]> = {}) {
  const props: Parameters<typeof ProjectsView>[0] = {
    projects: [],
    onAdd: vi.fn(),
    onToggleFavourite: vi.fn(),
    onToggleArchived: vi.fn(),
    ...overrides,
  };
  // ProjectsView links each row to `/todo/projects/:id` (react-router
  // `Link`), which throws outside a Router context — mirrors project-
  // view.test.tsx's own identical wrapper.
  return { ...render(<ProjectsView {...props} />, { wrapper: MemoryRouter }), props };
}

describe("ProjectsView — create under a parent (issue #297)", () => {
  it("offers No parent plus every existing Project, defaulting to No parent", () => {
    renderProjectsView({
      projects: [project({ id: "p1", name: "Groceries" }), project({ id: "p2", name: "Work" })],
    });

    const select = screen.getByLabelText("New Project's parent") as HTMLSelectElement;
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "No parent" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Work" })).toBeInTheDocument();
  });

  it("passes the chosen parent's id to onAdd on submit", () => {
    const onAdd = vi.fn();
    renderProjectsView({ projects: [project({ id: "p1", name: "Groceries" })], onAdd });

    fireEvent.change(screen.getByLabelText("New Project's name"), {
      target: { value: "Sub-list" },
    });
    fireEvent.change(screen.getByLabelText("New Project's parent"), {
      target: { value: "p1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith("Sub-list", expect.any(String), "p1");
  });

  it("passes null for No parent, the default", () => {
    const onAdd = vi.fn();
    renderProjectsView({ projects: [project({ id: "p1", name: "Groceries" })], onAdd });

    fireEvent.change(screen.getByLabelText("New Project's name"), {
      target: { value: "Top-level" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith("Top-level", expect.any(String), null);
  });

  it("resets the parent chooser back to No parent after a successful add", () => {
    renderProjectsView({ projects: [project({ id: "p1", name: "Groceries" })] });

    fireEvent.change(screen.getByLabelText("New Project's name"), {
      target: { value: "Sub-list" },
    });
    fireEvent.change(screen.getByLabelText("New Project's parent"), {
      target: { value: "p1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByLabelText("New Project's parent")).toHaveValue("");
  });
});

// Regression coverage for depthOf itself — todo-sidebar.test.tsx already
// covers it end-to-end via TodoSidebar's own indentation, this is the
// direct unit case for the function this file exports for that reuse.
describe("depthOf", () => {
  it("is 0 for a top-level Project and increases one hop per ancestor", () => {
    const root = project({ id: "p1", parentId: null });
    const child = project({ id: "p2", parentId: "p1" });
    const grandchild = project({ id: "p3", parentId: "p2" });
    const byId = new Map([root, child, grandchild].map((p) => [p.id, p] as const));

    expect(depthOf(root, byId)).toBe(0);
    expect(depthOf(child, byId)).toBe(1);
    expect(depthOf(grandchild, byId)).toBe(2);
  });
});
