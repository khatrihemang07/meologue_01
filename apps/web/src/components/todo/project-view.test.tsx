import type { Project, Section, Task } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { ProjectView } from "./project-view";

function openProjectMenuAndClick(itemName: string) {
  // Radix's `DropdownMenu.Trigger` opens on `pointerdown`, not `click`
  // (task-schedule-popover.test.tsx's own identical "Repeat menu"
  // precedent) — a plain `fireEvent.click` alone never opens it under
  // jsdom.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Project options menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: itemName }));
}

function openSectionMenu(rowIndex: number) {
  const triggers = screen.getAllByRole("button", { name: "Section options menu" });
  const trigger = triggers[rowIndex];
  if (trigger === undefined) throw new Error(`No Section row at index ${rowIndex}`);
  fireEvent.pointerDown(trigger);
}

/** Opens the given Section row's menu and clicks a top-level item by name. */
function openSectionMenuAndClick(rowIndex: number, itemName: string) {
  openSectionMenu(rowIndex);
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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    date: null,
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: "p1",
    sectionId: null,
    parentId: null,
    description: null,
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
    countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
    listTasksInProject: vi.fn(async () => []),
    ...overrides,
  };
  // Issue #184: ProjectView's own "Activity" link is a react-router
  // `Link`, which throws outside a Router context — wrapped here, once,
  // rather than at every call site.
  return { ...render(<ProjectView {...props} />, { wrapper: MemoryRouter }), props };
}

describe("ProjectView — Edit project dialog", () => {
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

  it("shows the 120-character counter and caps the name field (the n/120 reading)", async () => {
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

  // Issue #342 — this dialog's real opener is the "Edit" `DropdownMenu.
  // Item`, gone the instant its menu closes, before `ProjectEditDialog`
  // even mounts — the generic capture has nothing connected to restore to
  // at close, which is why `project-view.tsx` wires an explicit
  // `restoreFocusTo` at the "Project options menu" trigger.
  it("Cancel restores focus to the Project options menu trigger, not document.body", async () => {
    renderProjectView({ project: project({ name: "Groceries" }) });

    openProjectMenuAndClick("Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    // Drains the DropdownMenu's own deferred close-focus dispatch first
    // (`labels-view.test.tsx`'s own identical guard, `dialog.test.tsx`'s
    // header comment on why: this test's own target and the menu's own
    // default target are the identical button, so draining here is what
    // keeps the later assertion honest rather than coincidentally true).
    await new Promise((resolve) => setTimeout(resolve, 20));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Project options menu" }),
    );
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("ProjectView — delete (unchanged wording)", () => {
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

describe("ProjectView — Section options menu", () => {
  it("carries Edit, Move to…, Archive and Delete, in Todoist's own DOM order minus Duplicate/Copy link to section", () => {
    renderProjectView({ sections: [section()] });

    openSectionMenu(0);

    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Edit", "Move to…", "Archive", "Delete"]);
  });

  it("shows 'Unarchive' instead of 'Archive' for an already-archived Section", () => {
    renderProjectView({ sections: [section({ archived: true })] });

    openSectionMenu(0);

    expect(screen.getByRole("menuitem", { name: "Unarchive" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("the old always-visible inline buttons are gone", () => {
    renderProjectView({ sections: [section(), section({ id: "s2", name: "Second" })] });

    expect(screen.queryByRole("button", { name: /Move ".*" earlier/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move ".*" later/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive Section/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete Section/ })).not.toBeInTheDocument();
  });

  describe("Edit", () => {
    it("shows the Section's plain name until Edit is chosen, with no inline field visible", () => {
      renderProjectView({ sections: [section({ name: "Errands" })] });

      expect(screen.getByText("Errands")).toBeInTheDocument();
      expect(screen.queryByLabelText("Section name")).not.toBeInTheDocument();
    });

    it("reveals a prefilled inline field, replacing the plain name", () => {
      renderProjectView({ sections: [section({ name: "Errands" })] });

      openSectionMenuAndClick(0, "Edit");

      expect(screen.getByLabelText("Section name")).toHaveValue("Errands");
      expect(screen.queryByText("Errands")).not.toBeInTheDocument();
    });

    it("commits the rename on blur, exactly as the prior always-visible field did", () => {
      const onRenameSection = vi.fn();
      renderProjectView({ sections: [section({ name: "Errands" })], onRenameSection });

      openSectionMenuAndClick(0, "Edit");
      const field = screen.getByLabelText("Section name");
      fireEvent.change(field, { target: { value: "Chores" } });
      fireEvent.blur(field);

      expect(onRenameSection).toHaveBeenCalledWith("s1", "Chores");
      // The field closes back to plain text once committed.
      expect(screen.queryByLabelText("Section name")).not.toBeInTheDocument();
    });

    // Enter's own handler calls `.blur()` on the field itself — a genuine
    // blur event only fires if the field is really focused first (jsdom's
    // own rule, not a test artifact), so this waits for the real focus
    // Edit's own hand-off lands (this file's own
    // `focusSectionInputAfterCloseRef`/`onCloseAutoFocus` pair, the
    // identical issue #255 shape task-schedule-popover.test.tsx's "Custom…"
    // test already waits on) before firing the key.
    it("Enter commits the same way blur does", async () => {
      const onRenameSection = vi.fn();
      renderProjectView({ sections: [section({ name: "Errands" })], onRenameSection });

      openSectionMenuAndClick(0, "Edit");
      const field = screen.getByLabelText("Section name");
      await vi.waitFor(() => expect(field).toHaveFocus());
      fireEvent.change(field, { target: { value: "Chores" } });
      fireEvent.keyDown(field, { key: "Enter" });

      expect(onRenameSection).toHaveBeenCalledWith("s1", "Chores");
    });
  });

  describe("Move to… (reorders within the Project — meologue has no cross-Project Section move)", () => {
    it("offers Move earlier and Move later, keyboard-reachable through the menu", () => {
      renderProjectView({
        sections: [
          section({ id: "s1", name: "First", orderKey: "A" }),
          section({ id: "s2", name: "Second", orderKey: "B" }),
        ],
      });

      openSectionMenu(0);
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));

      expect(screen.getByRole("menuitem", { name: "Move earlier" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Move later" })).toBeInTheDocument();
    });

    it("Move earlier/Move later call the same onReorderSection the old buttons did", () => {
      const onReorderSection = vi.fn();
      renderProjectView({
        sections: [
          section({ id: "s1", name: "First", orderKey: "A" }),
          section({ id: "s2", name: "Second", orderKey: "B" }),
        ],
        onReorderSection,
      });

      openSectionMenu(1);
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Move earlier" }));

      expect(onReorderSection).toHaveBeenCalledWith("s2", expect.any(String));
    });

    it("disables Move earlier for the first Section and Move later for the last, with one Section disabling both", () => {
      renderProjectView({ sections: [section({ id: "s1", name: "Only" })] });

      openSectionMenu(0);
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));

      expect(screen.getByRole("menuitem", { name: "Move earlier" })).toHaveAttribute(
        "data-disabled",
      );
      expect(screen.getByRole("menuitem", { name: "Move later" })).toHaveAttribute("data-disabled");
    });
  });

  describe("Archive and Delete", () => {
    it("Delete names the true destruction count, awaited fresh before the dialog opens", async () => {
      const countSectionDestruction = vi.fn(async () => 7);
      renderProjectView({ sections: [section()], countSectionDestruction });

      openSectionMenuAndClick(0, "Delete");

      await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
      expect(countSectionDestruction).toHaveBeenCalledWith("s1");
      expect(screen.getByText(/destroys 7 Tasks/)).toBeInTheDocument();
      expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    });

    it('uses the singular "Task" for a count of exactly one', async () => {
      renderProjectView({ sections: [section()], countSectionDestruction: vi.fn(async () => 1) });

      openSectionMenuAndClick(0, "Delete");

      await waitFor(() => expect(screen.getByText(/destroys 1 Task\b/)).toBeInTheDocument());
    });

    it("only calls onDeleteSection after the confirmation, not on the menu selection alone", async () => {
      const onDeleteSection = vi.fn();
      renderProjectView({ sections: [section()], onDeleteSection });

      openSectionMenuAndClick(0, "Delete");
      await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
      expect(onDeleteSection).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Delete Section" }));

      expect(onDeleteSection).toHaveBeenCalledWith("s1");
    });

    it("cancelling leaves the Section untouched", async () => {
      const onDeleteSection = vi.fn();
      renderProjectView({ sections: [section()], onDeleteSection });

      openSectionMenuAndClick(0, "Delete");
      await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onDeleteSection).not.toHaveBeenCalled();
    });

    // Archive is the adjacent, non-destructive action (issue #171's own
    // brief: "make the difference in blast radius visible") — it never
    // opens the confirmation at all, unlike Delete.
    it("Archive never opens the delete confirmation", () => {
      const onArchiveSection = vi.fn();
      renderProjectView({ sections: [section()], onArchiveSection });

      openSectionMenuAndClick(0, "Archive");

      expect(onArchiveSection).toHaveBeenCalledWith("s1");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("Unarchive calls onUnarchiveSection", () => {
      const onUnarchiveSection = vi.fn();
      renderProjectView({ sections: [section({ archived: true })], onUnarchiveSection });

      openSectionMenuAndClick(0, "Unarchive");

      expect(onUnarchiveSection).toHaveBeenCalledWith("s1");
    });
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

describe("ProjectView — completed Tasks (issue #358)", () => {
  beforeEach(() => {
    useSettingsStore.getState().setCompletedTasksVisible(true);
  });

  afterEach(() => {
    useSettingsStore.getState().setCompletedTasksVisible(false);
  });

  it("renders a completed Task, even with no active Tasks in the Project", () => {
    renderProjectView({
      tasks: [],
      completedTasks: [
        task({ id: "done", content: "done already", completedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });

    expect(screen.getByRole("checkbox", { name: "Mark task as incomplete" })).toBeInTheDocument();
    expect(screen.getByText("done already")).toBeInTheDocument();
    // A scope holding only completed rows must not read as empty.
    expect(screen.queryByText(/Nothing in this Project yet/)).not.toBeInTheDocument();
  });

  it("un-completing calls the onUncomplete prop with the Task", () => {
    const onUncomplete = vi.fn();
    const completed = task({
      id: "done",
      content: "done already",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    renderProjectView({ tasks: [], completedTasks: [completed], onUncomplete });

    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as incomplete" }));

    expect(onUncomplete).toHaveBeenCalledWith(completed);
  });

  it("only shows completed Tasks that belong to this Project", () => {
    renderProjectView({
      tasks: [],
      completedTasks: [
        task({
          id: "elsewhere",
          content: "in another Project",
          projectId: "p2",
          completedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    expect(screen.queryByText("in another Project")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing in this Project yet/)).toBeInTheDocument();
  });

  it("hides completed Tasks entirely when the setting is off — Todoist's own measured default", () => {
    useSettingsStore.getState().setCompletedTasksVisible(false);
    renderProjectView({
      tasks: [],
      completedTasks: [
        task({ id: "done", content: "done already", completedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });

    expect(screen.queryByText("done already")).not.toBeInTheDocument();
    // A scope with only (hidden) completed Tasks reads as empty again,
    // matching Todoist's own off-state (task-list.tsx's own doc comment).
    expect(screen.getByText(/Nothing in this Project yet/)).toBeInTheDocument();
  });
});

describe("ProjectView — Parent project passthrough (issue #297)", () => {
  it("hides the Edit dialog's Parent field until a caller wires projects and onSetParent", async () => {
    renderProjectView({ project: project({ name: "Groceries" }) });

    openProjectMenuAndClick("Edit");

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.queryByLabelText("Project parent")).not.toBeInTheDocument();
  });

  it("forwards projects and onSetParent to the Edit dialog, making reparenting reachable from this screen", async () => {
    const onSetParent = vi.fn(async () => {});
    const current = project({ id: "p1", name: "Groceries", parentId: null });
    const other = project({ id: "p2", name: "Work", parentId: null });
    renderProjectView({ project: current, projects: [current, other], onSetParent });

    openProjectMenuAndClick("Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Project parent"), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSetParent).toHaveBeenCalledWith("p2"));
  });
});
