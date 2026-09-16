import type { Project } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectEditDialog } from "./project-edit-dialog";

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

function renderDialog(overrides: Partial<Parameters<typeof ProjectEditDialog>[0]> = {}) {
  const props: Parameters<typeof ProjectEditDialog>[0] = {
    open: true,
    onOpenChange: vi.fn(),
    project: project(),
    projects: [project()],
    onRename: vi.fn(),
    onSetColour: vi.fn(),
    onSetDescription: vi.fn(),
    onSetParent: vi.fn(async () => {}),
    ...overrides,
  };
  return { ...render(<ProjectEditDialog {...props} />), props };
}

describe("ProjectEditDialog — Parent project (issue #297)", () => {
  it("hides the Parent project field when onSetParent isn't wired", () => {
    renderDialog({ onSetParent: undefined });

    expect(screen.queryByLabelText("Project parent")).not.toBeInTheDocument();
  });

  it("prefills the current parent, or No parent for a top-level Project", () => {
    const home = project({ id: "p0", name: "Home", parentId: null });
    const current = project({ id: "p1", name: "Groceries", parentId: "p0" });
    renderDialog({ project: current, projects: [home, current] });

    expect(screen.getByLabelText("Project parent")).toHaveValue("p0");
  });

  it("defaults to No parent for a Project with no parent", () => {
    renderDialog({ project: project({ id: "p1", parentId: null }) });

    expect(screen.getByLabelText("Project parent")).toHaveValue("");
  });

  it("offers every other Project as a parent option", () => {
    const projects = [
      project({ id: "p1", name: "Groceries" }),
      project({ id: "p2", name: "Work" }),
      project({ id: "p3", name: "Home" }),
    ];
    renderDialog({ project: projects[0] as Project, projects });

    expect(screen.getByRole("option", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Home" })).toBeInTheDocument();
  });

  it("never offers the Project itself as its own parent", () => {
    const projects = [
      project({ id: "p1", name: "Groceries" }),
      project({ id: "p2", name: "Work" }),
    ];
    renderDialog({ project: projects[0] as Project, projects });

    expect(screen.queryByRole("option", { name: "Groceries" })).not.toBeInTheDocument();
  });

  it("never offers a descendant as a parent, which would create a cycle", () => {
    const root = project({ id: "p1", name: "Root", parentId: null });
    const child = project({ id: "p2", name: "Child", parentId: "p1" });
    const grandchild = project({ id: "p3", name: "Grandchild", parentId: "p2" });
    const unrelated = project({ id: "p4", name: "Unrelated", parentId: null });
    renderDialog({ project: root, projects: [root, child, grandchild, unrelated] });

    expect(screen.queryByRole("option", { name: "Child" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Grandchild" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Unrelated" })).toBeInTheDocument();
  });

  it("calls onSetParent with the chosen parent's id on Save", async () => {
    const onSetParent = vi.fn(async () => {});
    const projects = [
      project({ id: "p1", name: "Groceries", parentId: null }),
      project({ id: "p2", name: "Work", parentId: null }),
    ];
    renderDialog({ project: projects[0] as Project, projects, onSetParent });

    fireEvent.change(screen.getByLabelText("Project parent"), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSetParent).toHaveBeenCalledWith("p2"));
  });

  it("calls onSetParent(null) when moved back to No parent", async () => {
    const onSetParent = vi.fn(async () => {});
    const projects = [
      project({ id: "p1", name: "Groceries", parentId: "p2" }),
      project({ id: "p2", name: "Work", parentId: null }),
    ];
    renderDialog({ project: projects[0] as Project, projects, onSetParent });

    fireEvent.change(screen.getByLabelText("Project parent"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSetParent).toHaveBeenCalledWith(null));
  });

  it("does not call onSetParent when the parent is left unchanged", async () => {
    const onSetParent = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    const projects = [project({ id: "p1", name: "Groceries", parentId: null })];
    renderDialog({ project: projects[0] as Project, projects, onSetParent, onOpenChange });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSetParent).not.toHaveBeenCalled();
  });

  it("surfaces the store's own rejection instead of closing the dialog", async () => {
    const onOpenChange = vi.fn();
    const onSetParent = vi.fn(async () => {
      throw new Error("setProjectParent: a Project cannot be its own parent");
    });
    const projects = [
      project({ id: "p1", name: "Groceries", parentId: null }),
      project({ id: "p2", name: "Work", parentId: null }),
    ];
    renderDialog({ project: projects[0] as Project, projects, onSetParent, onOpenChange });

    fireEvent.change(screen.getByLabelText("Project parent"), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("cannot be its own parent"),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
