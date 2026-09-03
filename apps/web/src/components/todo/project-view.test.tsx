import type { Project, Section } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectView } from "./project-view";

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
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function section(overrides: Partial<Section> = {}): Section {
  return {
    id: "s1",
    deviceId: "device-a",
    projectId: "p1",
    name: "Errands",
    description: null,
    orderKey: "A",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function renderProjectView(overrides: Partial<Parameters<typeof ProjectView>[0]> = {}) {
  const props: Parameters<typeof ProjectView>[0] = {
    project: project(),
    sections: [],
    tasks: [],
    detailActions: {
      projects: [],
      labels: [],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
    onRename: vi.fn(),
    onSetDescription: vi.fn(),
    onToggleFavourite: vi.fn(),
    onToggleArchived: vi.fn(),
    onAddSection: vi.fn(async () => {}),
    onRenameSection: vi.fn(),
    onReorderSection: vi.fn(),
    onArchiveSection: vi.fn(),
    onUnarchiveSection: vi.fn(),
    onDeleteSection: vi.fn(),
    countSectionDestruction: vi.fn(async () => 0),
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
    onMoveToSection: vi.fn(),
    reorderTask: vi.fn(),
    setTaskParent: vi.fn(async () => {}),
    listTaskChildren: vi.fn(async () => []),
    listTasksInProject: vi.fn(async () => []),
    ...overrides,
  };
  return { ...render(<ProjectView {...props} />), props };
}

describe("ProjectView — Section delete", () => {
  // The confirmation names the count and says it cannot be undone (issue
  // #171's own acceptance criterion, and the divergence 171-brief.md
  // records from Todoist's own gentler dialog): the reader sees the real
  // number before confirming, not a generic warning.
  it("names the true destruction count, awaited fresh before the dialog opens", async () => {
    const countSectionDestruction = vi.fn(async () => 7);
    renderProjectView({ sections: [section()], countSectionDestruction });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Section "Errands"' }));

    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(countSectionDestruction).toHaveBeenCalledWith("s1");
    expect(screen.getByText(/destroys 7 Tasks/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
  });

  it('uses the singular "Task" for a count of exactly one', async () => {
    renderProjectView({ sections: [section()], countSectionDestruction: vi.fn(async () => 1) });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Section "Errands"' }));

    await waitFor(() => expect(screen.getByText(/destroys 1 Task\b/)).toBeInTheDocument());
  });

  it("only calls onDeleteSection after the confirmation, not on the request alone", async () => {
    const onDeleteSection = vi.fn();
    renderProjectView({ sections: [section()], onDeleteSection });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Section "Errands"' }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(onDeleteSection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Section" }));

    expect(onDeleteSection).toHaveBeenCalledWith("s1");
  });

  it("cancelling leaves the Section untouched", async () => {
    const onDeleteSection = vi.fn();
    renderProjectView({ sections: [section()], onDeleteSection });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Section "Errands"' }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDeleteSection).not.toHaveBeenCalled();
  });

  // Archive is the adjacent, non-destructive action (issue #171's own
  // brief: "make the difference in blast radius visible") — it never
  // opens the confirmation at all, unlike Delete.
  it("archiving a Section never opens the delete confirmation", () => {
    const onArchiveSection = vi.fn();
    renderProjectView({ sections: [section()], onArchiveSection });

    fireEvent.click(screen.getByRole("button", { name: 'Archive Section "Errands"' }));

    expect(onArchiveSection).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("ProjectView — Sections cap", () => {
  it("shows the twenty-cap message instead of the add form once reached", () => {
    const sections = Array.from({ length: 20 }, (_, i) => section({ id: `s${i}`, name: `S${i}` }));
    renderProjectView({ sections });

    expect(screen.getByText(/already holds twenty Sections/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New Section's name")).not.toBeInTheDocument();
  });

  // A refusal legibly shown where the reader was trying to add one — not
  // a throw into a void (issue #171's own brief).
  it("shows the store's own refusal message when adding a Section fails", async () => {
    const onAddSection = vi.fn(async () => {
      throw new Error("a Project may hold at most 20 Sections");
    });
    renderProjectView({ onAddSection });

    fireEvent.change(screen.getByLabelText("New Section's name"), {
      target: { value: "One too many" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Section" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("a Project may hold at most 20 Sections"),
    );
  });
});
