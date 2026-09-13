import type { Project, Section } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ProjectView } from "./project-view";

/** Opens the project's own "Project options menu" (STR-02) and clicks the named item. */
function openProjectMenuAndClick(itemName: string) {
  // Radix's `DropdownMenu.Trigger` opens on `pointerdown`, not `click`
  // (task-schedule-popover.test.tsx's own identical "Repeat menu"
  // precedent) — a plain `fireEvent.click` alone never opens it under
  // jsdom.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Project options menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: itemName }));
}

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
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    updatedAt: "2026-01-01T00:00:00.000Z",
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
      onSetDate: vi.fn(),
      onSetDateString: vi.fn(),
      datesWithTasks: new Map(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      onRename: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
    onRename: vi.fn(),
    onSetColour: vi.fn(),
    onSetDescription: vi.fn(),
    onToggleFavourite: vi.fn(),
    onToggleArchived: vi.fn(),
    onDeleteProject: vi.fn(),
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
  // Issue #184: ProjectView's own "Activity" link is a react-router
  // `Link`, which throws outside a Router context — wrapped here, once,
  // rather than at every call site.
  return { ...render(<ProjectView {...props} />, { wrapper: MemoryRouter }), props };
}

describe("ProjectView — Edit project dialog (STR-02)", () => {
  it("opens from the Project options menu, prefilled with the current name, colour and description", async () => {
    renderProjectView({
      project: project({ name: "Groceries", colour: "#DC4C3E", description: "Weekly shop" }),
    });

    openProjectMenuAndClick("Edit");

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText("Edit project")).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("Groceries");
    expect(screen.getByLabelText("Project colour")).toHaveValue("#DC4C3E");
    expect(screen.getByLabelText("Project description")).toHaveValue("Weekly shop");
  });

  it("shows the 120-character counter and caps the name field (STR-02's own n/120 reading)", async () => {
    renderProjectView({ project: project({ name: "Groceries" }) });

    openProjectMenuAndClick("Edit");

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText("9/120")).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveAttribute("maxLength", "120");
  });

  it("renames, recolours and sets the description together on Save", async () => {
    const onRename = vi.fn();
    const onSetColour = vi.fn();
    const onSetDescription = vi.fn();
    renderProjectView({
      project: project({ name: "Groceries", colour: "#DC4C3E", description: null }),
      onRename,
      onSetColour,
      onSetDescription,
    });

    openProjectMenuAndClick("Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Groceries 2" } });
    fireEvent.change(screen.getByLabelText("Project colour"), { target: { value: "#4180FF" } });
    fireEvent.change(screen.getByLabelText("Project description"), {
      target: { value: "Weekly shop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).toHaveBeenCalledWith("Groceries 2");
    expect(onSetColour).toHaveBeenCalledWith("#4180FF");
    expect(onSetDescription).toHaveBeenCalledWith("Weekly shop");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does not call the setters for fields that did not change", async () => {
    const onRename = vi.fn();
    const onSetColour = vi.fn();
    const onSetDescription = vi.fn();
    renderProjectView({
      project: project({ name: "Groceries", colour: "#DC4C3E", description: null }),
      onRename,
      onSetColour,
      onSetDescription,
    });

    openProjectMenuAndClick("Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(onSetColour).not.toHaveBeenCalled();
    expect(onSetDescription).not.toHaveBeenCalled();
  });

  it("Cancel discards edits", async () => {
    const onRename = vi.fn();
    renderProjectView({ project: project({ name: "Groceries" }), onRename });

    openProjectMenuAndClick("Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Groceries")).toBeInTheDocument();
  });

  // A reopen after an edited-then-cancelled session must show the
  // Project's real name again, not whatever was typed and abandoned last
  // time — the dialog remounts fresh on every open (this file's own
  // `key={editing ? "open" : "closed"}` on `ProjectEditDialog`).
  it("reopening after Cancel shows the Project's real name again, not the discarded edit", async () => {
    renderProjectView({ project: project({ name: "Groceries" }) });

    openProjectMenuAndClick("Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Discarded" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    openProjectMenuAndClick("Edit");

    await waitFor(() => expect(screen.getByLabelText("Project name")).toHaveValue("Groceries"));
  });
});

describe("ProjectView — delete (STR-01, unchanged wording)", () => {
  // Verbatim (docs/reference/todoist/quick-add.md § "Destructive
  // confirmation wording"): "Delete project? The <name> project and all
  // its tasks will be permanently deleted. This action cannot be undone."
  it("shows Todoist's own verbatim delete wording", async () => {
    renderProjectView({ project: project({ name: "Groceries" }) });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Project "Groceries"' }));

    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(screen.getByText("Delete project?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The Groceries project and all its tasks will be permanently deleted. This action cannot be undone.",
      ),
    ).toBeInTheDocument();
  });

  it("only calls onDeleteProject after the confirmation, not on the request alone", async () => {
    const onDeleteProject = vi.fn();
    renderProjectView({ onDeleteProject });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Project "Groceries"' }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(onDeleteProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDeleteProject).toHaveBeenCalled();
  });

  it("cancelling leaves the Project untouched", async () => {
    const onDeleteProject = vi.fn();
    renderProjectView({ onDeleteProject });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Project "Groceries"' }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDeleteProject).not.toHaveBeenCalled();
  });
});

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
