import type { Comment, Label, Project, Section, Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetailView } from "./task-detail-view";

/**
 * Stands in for the real `TaskTitleEditor` — see `task-title-editor.tsx`'s
 * own header comment for why no test mounts that component directly (it
 * wraps a real ProseMirror `EditorView`, which jsdom cannot usefully
 * mount). `task-row.test.tsx` mocks the identical module the identical
 * way, for the identical reason. `commitOnBlur` is honoured here — issue
 * #229's own DET-09 rework passes `commitOnBlur={false}` for real, and a
 * stub that ignored it would let a test pass for the wrong reason.
 * `autoFocus` is honoured too — DET-10's own focus-trap tests below need
 * this stub to actually move focus, the same real thing `view.focus()`
 * does.
 */
function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
  commitOnBlur = true,
  autoFocus = true,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  commitOnBlur?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, mirroring the real editor's own mount-time focus.
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, []);
  return (
    <input
      ref={ref}
      aria-label={ariaLabel ?? "Task name"}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange?.(event.target.value);
      }}
      onBlur={() => {
        if (commitOnBlur) {
          onCommit(text);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit(text);
        }
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

/**
 * Stands in for the real `TaskDescriptionEditor` (issue #229) — the
 * identical "mock exactly the piece that needs a real browser" split
 * `StubTaskTitleEditor` above already takes, since it too wraps a real
 * ProseMirror `EditorView`.
 */
function StubTaskDescriptionEditor({
  value,
  onChange,
  onCancel,
  autoFocus = true,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, mirroring the real editor's own mount-time focus.
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, []);
  return (
    <textarea
      ref={ref}
      aria-label="Description"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

vi.mock("@/components/todo/task-description-editor", () => ({
  TaskDescriptionEditor: StubTaskDescriptionEditor,
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
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
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    deviceId: "device-a",
    name: "Errands",
    colour: "#ff8d85",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "V",
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
    name: "This week",
    description: null,
    orderKey: "V",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function label(overrides: Partial<Label> = {}): Label {
  return {
    id: "l1",
    deviceId: "device-a",
    name: "Home",
    colour: "#ff8d85",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    deviceId: "device-a",
    taskId: "1",
    text: "sounds good",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function renderView(overrides: Partial<Parameters<typeof TaskDetailView>[0]> = {}) {
  const props = {
    task: task(),
    project: null,
    section: null,
    projects: [],
    labels: [],
    prevTask: null,
    nextTask: null,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onRename: vi.fn(),
    onComplete: vi.fn(),
    onUncomplete: vi.fn(),
    onOpenSchedule: vi.fn(),
    onSetProject: vi.fn(),
    onSetLabels: vi.fn(),
    onSetDescription: vi.fn(),
    comments: [],
    onAddComment: vi.fn(),
    onEditComment: vi.fn(),
    onRemoveComment: vi.fn(),
    subtasks: [],
    onAddSubtask: vi.fn(),
    onCompleteSubtask: vi.fn(),
    onUncompleteSubtask: vi.fn(),
    events: [],
    ...overrides,
  };
  render(<TaskDetailView {...props} />);
  return props;
}

describe("TaskDetailView", () => {
  it("renders as a dialog, carrying the Task's own title as a display element, not an editor, at rest", () => {
    // DET-02: Todoist's own detail title at rest is a non-editable
    // display component, not the composer's editor — a `<button>` here,
    // not `getByLabelText("Task name")`, which only exists once
    // `editingTitle` is activated (below).
    renderView({ task: task({ content: "call mum" }) });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "call mum" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
  });

  it("carries DET-05's own data-testid (keyboard.md §1) on the dialog content", () => {
    renderView({ task: task({ content: "call mum" }) });

    expect(screen.getByTestId("task-details-modal")).toBe(screen.getByRole("dialog"));
  });

  it("does not autofocus the title on open, so a phone doesn't pop the keyboard for a tap that's usually just a look", () => {
    renderView({ task: task({ content: "call mum" }) });

    expect(screen.getByRole("button", { name: "call mum" })).not.toHaveFocus();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("clicking the title activates the shared editor, seeded with the current content", async () => {
    renderView({ task: task({ content: "call mum" }) });

    fireEvent.click(screen.getByRole("button", { name: "call mum" }));

    expect(await screen.findByLabelText("Task name")).toHaveValue("call mum");
  });

  describe("DET-09/DET-10 — task-wide editing and the focus trap", () => {
    it("clicking the title activates BOTH the title and the description editors together, sharing one Cancel/Save pair", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByRole("button", { name: "call mum" }));

      expect(await screen.findByLabelText("Task name")).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    it("clicking the description also activates BOTH editors together", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(await screen.findByLabelText("Task name")).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toBeInTheDocument();
    });

    it("clicking the description's own click target focuses the description, not the title", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(await screen.findByLabelText("Description")).toHaveFocus();
    });

    it("clicking the title (a generic entry point, not the description's own) focuses the title", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByRole("button", { name: "call mum" }));

      expect(await screen.findByLabelText("Task name")).toHaveFocus();
    });

    it("saves both the title and the description together from one Save click", async () => {
      const onRename = vi.fn();
      const onSetDescription = vi.fn();
      renderView({
        task: task({ content: "old title", description: "old text" }),
        onRename,
        onSetDescription,
      });

      fireEvent.click(screen.getByRole("button", { name: "old title" }));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "new title" },
      });
      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "new text" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onRename).toHaveBeenCalledWith("new title");
      expect(onSetDescription).toHaveBeenCalledWith("new text");
    });

    it("Cancel discards both drafts and returns to the display state", async () => {
      const onRename = vi.fn();
      const onSetDescription = vi.fn();
      renderView({
        task: task({ content: "old title", description: "old text" }),
        onRename,
        onSetDescription,
      });

      fireEvent.click(screen.getByRole("button", { name: "old title" }));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onRename).not.toHaveBeenCalled();
      expect(onSetDescription).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "old title" })).toBeInTheDocument();
    });
  });

  it("the breadcrumb reads Inbox for a Task with no Project", () => {
    renderView({ project: null, section: null });

    expect(screen.getByRole("dialog").querySelector("header")).toHaveTextContent("Inbox");
  });

  it("the breadcrumb names the Project and Section", () => {
    renderView({
      project: project({ name: "Errands" }),
      section: section({ name: "This week" }),
    });

    expect(screen.getByRole("dialog").querySelector("header")).toHaveTextContent(
      "Errands / This week",
    );
  });

  it("renaming commits when the Save button is clicked, trimmed", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByRole("button", { name: "old title" }));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "  new title  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).toHaveBeenCalledWith("new title");
  });

  it("does not commit a rename when the title is unchanged or blank", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByRole("button", { name: "old title" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "old title" }));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("DET-09: blur alone does not commit or close the combined edit form", async () => {
    // Moving focus from the title into the description (still inside the
    // same form) must not save or cancel — only Enter, Escape or the
    // explicit Save/Cancel pair do, per DET-09's own "one Cancel/Save
    // pair" rule.
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByRole("button", { name: "old title" }));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "discard me" } });
    fireEvent.blur(titleField);

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "old title" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task name")).toBeInTheDocument();
  });

  it("Enter commits the title without adding a newline", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByRole("button", { name: "old title" }));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "new title" } });
    fireEvent.keyDown(titleField, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("new title");
  });

  it("Escape cancels the in-progress edit and returns to the display title, without renaming", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByRole("button", { name: "old title" }));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "discard me" } });
    fireEvent.keyDown(titleField, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "old title" })).toBeInTheDocument();
  });

  it("prev/next chevrons are disabled when there's nothing further, and call onNavigate when there is", () => {
    const onNavigate = vi.fn();
    const prev = task({ id: "0", content: "earlier" });
    const next = task({ id: "2", content: "later" });
    renderView({ prevTask: prev, nextTask: next, onNavigate });

    fireEvent.click(screen.getByRole("button", { name: "Previous Task" }));
    fireEvent.click(screen.getByRole("button", { name: "Next Task" }));

    expect(onNavigate).toHaveBeenCalledWith(prev);
    expect(onNavigate).toHaveBeenCalledWith(next);
  });

  it("disables the chevron toward a direction with no neighbour", () => {
    renderView({ prevTask: null, nextTask: null });

    expect(screen.getByRole("button", { name: "Previous Task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next Task" })).toBeDisabled();
  });

  it("Esc closes the view", () => {
    const onClose = vi.fn();
    renderView({ onClose });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Date, Deadline and Priority all open the identical shared schedule sheet", () => {
    const onOpenSchedule = vi.fn();
    renderView({ onOpenSchedule });

    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.click(screen.getByRole("button", { name: "Deadline" }));
    fireEvent.click(screen.getByRole("button", { name: "Priority" }));

    expect(onOpenSchedule).toHaveBeenCalledTimes(3);
  });

  it("an unset Date/Deadline/Priority renders a pill; once set, each is promoted into its own row", () => {
    renderView({
      task: task({ date: "2026-09-03", priority: 4 }), // stored 4 is UI P1.
    });

    // Date is set — a promoted row naming its value, not a bare pill.
    expect(screen.getByRole("button", { name: /Date.*Sep 3/s })).toBeInTheDocument();
    // Deadline is still unset — a pill, exactly the word "Deadline".
    expect(screen.getByRole("button", { name: "Deadline" })).toBeInTheDocument();
    // Priority is set — a promoted row naming P1.
    expect(screen.getByRole("button", { name: /Priority.*P1/s })).toBeInTheDocument();
  });

  it("Project is always a promoted row, Inbox included — there's no 'unset' Project to pill", () => {
    renderView({ project: null });

    expect(screen.getByRole("button", { name: /Project.*Inbox/s })).toBeInTheDocument();
  });

  it("choosing a Project from the picker calls onSetProject", () => {
    const onSetProject = vi.fn();
    renderView({
      onSetProject,
      projects: [project({ id: "p2", name: "Home renovation" })],
    });

    fireEvent.click(screen.getByRole("button", { name: /^Project/ }));
    fireEvent.change(screen.getByLabelText("Move to Project"), { target: { value: "p2" } });

    expect(onSetProject).toHaveBeenCalledWith("p2");
  });

  it("an unset Labels attribute is a pill; toggling one on calls onSetLabels", () => {
    const onSetLabels = vi.fn();
    renderView({
      onSetLabels,
      labels: [label({ id: "l1", name: "Home" })],
      task: task({ labelIds: [] }),
    });

    expect(screen.getByRole("button", { name: "Labels" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Home/ }));

    expect(onSetLabels).toHaveBeenCalledWith(["l1"]);
  });

  it("a set Labels attribute is promoted into a row naming every Label", () => {
    renderView({
      labels: [label({ id: "l1", name: "Home" }), label({ id: "l2", name: "Errands" })],
      task: task({ labelIds: ["l1", "l2"] }),
    });

    expect(screen.getByRole("button", { name: /Labels.*Home, Errands/s })).toBeInTheDocument();
  });

  describe("Description — issue #180", () => {
    it("an unset Description renders a pill", () => {
      renderView({ task: task({ description: null }) });

      expect(screen.getByRole("button", { name: "Description" })).toBeInTheDocument();
    });

    it("a set Description is promoted into a rendered, click-to-edit block", () => {
      renderView({ task: task({ description: "buy the *good* milk" }) });

      expect(screen.queryByRole("button", { name: "Description" })).not.toBeInTheDocument();
      // Rendered as Markdown by the same renderer an Entry's body uses —
      // "*good*" reads as emphasis, not literal asterisks.
      expect(screen.getByText("good").tagName).toBe("EM");
    });

    it("tapping the pill opens the shared description editor, seeded with the current text", async () => {
      renderView({ task: task({ description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(await screen.findByLabelText("Description")).toHaveValue("existing text");
    });

    it("commits a new Description when Save is clicked, trimmed", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: null }), onSetDescription });

      fireEvent.click(screen.getByRole("button", { name: "Description" }));
      const field = await screen.findByLabelText("Description");
      fireEvent.change(field, { target: { value: "  a plan\n\n- step one\n- step two  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onSetDescription).toHaveBeenCalledWith("a plan\n\n- step one\n- step two");
    });

    it("clearing a Description back to blank sets it to null", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "something" }), onSetDescription });

      fireEvent.click(screen.getByText("something"));
      const field = await screen.findByLabelText("Description");
      fireEvent.change(field, { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onSetDescription).toHaveBeenCalledWith(null);
    });

    it("does not commit when the text is unchanged", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "unchanged" }), onSetDescription });

      fireEvent.click(screen.getByText("unchanged"));
      await screen.findByLabelText("Description");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onSetDescription).not.toHaveBeenCalled();
    });

    it("Escape reverts an in-progress edit without committing", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "original" }), onSetDescription });

      fireEvent.click(screen.getByText("original"));
      const field = await screen.findByLabelText("Description");
      fireEvent.change(field, { target: { value: "discard me" } });
      fireEvent.keyDown(field, { key: "Escape" });

      expect(onSetDescription).not.toHaveBeenCalled();
      expect(screen.getByText("original")).toBeInTheDocument();
    });
  });

  describe("Comments — issue #180", () => {
    it("renders no thread heading when there are no Comments yet", () => {
      renderView({ comments: [] });

      expect(screen.getByText("Comments")).toBeInTheDocument();
      expect(screen.queryByText(/^Comments \(/)).not.toBeInTheDocument();
    });

    it("lists every Comment, oldest first as handed in, each rendered as Markdown", () => {
      renderView({
        comments: [
          comment({ id: "c1", text: "first *reply*" }),
          comment({ id: "c2", text: "second reply" }),
        ],
      });

      expect(screen.getByText("Comments (2)")).toBeInTheDocument();
      expect(screen.getByText("reply", { selector: "em" })).toBeInTheDocument();
      expect(screen.getByText("second reply")).toBeInTheDocument();
    });

    it("the composer is always visible, and submitting adds a Comment and clears the field", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      const field = screen.getByLabelText("Add a comment");
      fireEvent.change(field, { target: { value: "  a new comment  " } });
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));

      expect(onAddComment).toHaveBeenCalledWith("a new comment");
      expect(field).toHaveValue("");
    });

    it("CMT-01: Ctrl/Cmd+Enter submits — plain Enter and Shift+Enter do not (the opposite of the task composer)", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      const field = screen.getByLabelText("Add a comment");
      fireEvent.change(field, { target: { value: "typed" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onAddComment).not.toHaveBeenCalled();

      fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
      expect(onAddComment).not.toHaveBeenCalled();

      fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
      expect(onAddComment).toHaveBeenCalledWith("typed");
    });

    it("CMT-01: Cmd+Enter (metaKey) also submits", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      const field = screen.getByLabelText("Add a comment");
      fireEvent.change(field, { target: { value: "typed" } });
      fireEvent.keyDown(field, { key: "Enter", metaKey: true });

      expect(onAddComment).toHaveBeenCalledWith("typed");
    });

    it("ignores a blank comment", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      fireEvent.click(screen.getByRole("button", { name: "Comment" }));

      expect(onAddComment).not.toHaveBeenCalled();
    });

    it("editing a Comment opens a textarea seeded with its text, and commits on blur", () => {
      const onEditComment = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onEditComment });

      fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
      const field = screen.getByLabelText("Edit comment");
      expect(field).toHaveValue("original");
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.blur(field);

      expect(onEditComment).toHaveBeenCalledWith("c1", "changed");
    });

    it("CMT-03: deleting a Comment asks for confirmation first, and does not remove until confirmed", () => {
      const onRemoveComment = vi.fn();
      renderView({ comments: [comment({ id: "c1" })], onRemoveComment });

      fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

      // Not removed yet — the confirm dialog is open, not the delete itself.
      expect(onRemoveComment).not.toHaveBeenCalled();
      expect(screen.getByText("Delete comment?")).toBeInTheDocument();
      expect(screen.getByText("This comment will be permanently deleted.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      expect(onRemoveComment).toHaveBeenCalledWith("c1");
    });

    it("CMT-03: Cancelling the delete confirmation removes nothing", () => {
      const onRemoveComment = vi.fn();
      renderView({ comments: [comment({ id: "c1" })], onRemoveComment });

      fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onRemoveComment).not.toHaveBeenCalled();
    });
  });

  describe("Sub-tasks — issue #229", () => {
    it("renders no count when there are no sub-tasks yet", () => {
      renderView({ subtasks: [] });

      expect(screen.getByText("Sub-tasks")).toBeInTheDocument();
      expect(screen.queryByText(/^Sub-tasks \(/)).not.toBeInTheDocument();
    });

    // Renamed from "struck through once completed": whether a completed
    // sub-task is struck through is the reader's own setting to make
    // (#237), and this surface arrived hardcoding it. What the list owes
    // is that a completed sub-task is MARKED as completed, through the one
    // class index.css drives, and an active one is not.
    it("lists every sub-task, marked completed once completed", () => {
      renderView({
        subtasks: [
          task({ id: "s1", content: "buy eggs", completedAt: null }),
          task({ id: "s2", content: "wash the car", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
      });

      expect(screen.getByText("Sub-tasks (2)")).toBeInTheDocument();
      expect(screen.getByText("buy eggs")).not.toHaveClass("completed-task-text");
      expect(screen.getByText("wash the car")).toHaveClass("completed-task-text");
      expect(screen.getByText("wash the car")).not.toHaveClass("line-through");
    });

    it("completing/uncompleting a sub-task calls the matching handler with its id", () => {
      const onCompleteSubtask = vi.fn();
      const onUncompleteSubtask = vi.fn();
      renderView({
        subtasks: [
          task({ id: "s1", content: "buy eggs", completedAt: null }),
          task({ id: "s2", content: "wash the car", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
        onCompleteSubtask,
        onUncompleteSubtask,
      });

      fireEvent.click(screen.getByLabelText('Complete "buy eggs"'));
      fireEvent.click(screen.getByLabelText('Mark "wash the car" not done'));

      expect(onCompleteSubtask).toHaveBeenCalledWith("s1");
      expect(onUncompleteSubtask).toHaveBeenCalledWith("s2");
    });

    it("adding a sub-task submits the typed text and clears the field", () => {
      const onAddSubtask = vi.fn();
      renderView({ onAddSubtask });

      const field = screen.getByLabelText("Add sub-task");
      fireEvent.change(field, { target: { value: "  water the plants  " } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(onAddSubtask).toHaveBeenCalledWith("water the plants");
      expect(field).toHaveValue("");
    });

    it("ignores a blank sub-task", () => {
      const onAddSubtask = vi.fn();
      renderView({ onAddSubtask });

      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(onAddSubtask).not.toHaveBeenCalled();
    });
  });

  it("shows no duration control anywhere — Task.duration was removed in #179", () => {
    renderView();

    expect(screen.queryByText(/[Dd]uration/)).not.toBeInTheDocument();
  });

  // Issue #184's own gap-fix report: this view now resolves (and must
  // render actionable) a completed Task, not only an active one — "do
  // not make it read-only."
  describe("a completed Task", () => {
    // Issue #237: the title used to hardcode `text-muted-foreground
    // line-through` unconditionally on a completed Task, bypassing the
    // "Completed checklist item" setting (`data-completed-style`,
    // index.css) that History/Composer already honour.
    // `.completed-task-text` is the shared class index.css's one rule now
    // also reads — asserting it (and that the old hardcoded class is gone)
    // is what would catch a regression back to hardcoding. jsdom applies
    // no real cascade, so this only proves the class is present/absent,
    // not the resulting decoration or colour.
    it("shows the checkbox checked and gives the title the shared completed-style class", () => {
      renderView({ task: task({ completedAt: "2026-01-02T00:00:00.000Z", content: "call mum" }) });

      const checkbox = screen.getByLabelText('Mark "call mum" not done');
      expect(checkbox).toBeChecked();
      // Their selector (#229 made the at-rest title a button, not a
      // labelled textarea), this branch's assertion (#237: the shared
      // class, never a hardcoded decoration).
      const title = screen.getByRole("button", { name: "call mum" });
      expect(title).toHaveClass("completed-task-text");
      expect(title).not.toHaveClass("line-through");
    });

    it("clicking the checkbox calls onUncomplete", () => {
      const onUncomplete = vi.fn();
      renderView({
        task: task({ completedAt: "2026-01-02T00:00:00.000Z", content: "call mum" }),
        onUncomplete,
      });

      fireEvent.click(screen.getByLabelText('Mark "call mum" not done'));

      expect(onUncomplete).toHaveBeenCalled();
    });

    it("the title remains editable", async () => {
      const onRename = vi.fn();
      renderView({ task: task({ completedAt: "2026-01-02T00:00:00.000Z" }), onRename });

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));
      const field = await screen.findByLabelText("Task name");
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onRename).toHaveBeenCalledWith("changed");
    });
  });

  describe("an active Task", () => {
    it("shows the checkbox unchecked, with no strikethrough", () => {
      renderView({ task: task({ completedAt: null, content: "call mum" }) });

      const checkbox = screen.getByLabelText('Complete "call mum"');
      expect(checkbox).not.toBeChecked();
      const title = screen.getByRole("button", { name: "call mum" });
      expect(title).not.toHaveClass("line-through");
      expect(title).not.toHaveClass("completed-task-text");
    });

    it("clicking the checkbox calls onComplete", () => {
      const onComplete = vi.fn();
      renderView({ task: task({ completedAt: null, content: "call mum" }), onComplete });

      fireEvent.click(screen.getByLabelText('Complete "call mum"'));

      expect(onComplete).toHaveBeenCalled();
    });
  });
});

// `installMatchMedia`/`removeMatchMedia` mirror use-wide-layout.test.ts's
// own stand-in exactly ("jsdom implements no matchMedia at all") — this
// suite reaches for the identical shape rather than a second, ad hoc one.
function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("TaskDetailView on a narrow screen", () => {
  afterEach(removeMatchMedia);

  it("still renders as a dialog, with a drag handle rather than the wide close button", () => {
    installMatchMedia(false);

    renderView();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});

describe("TaskDetailView on a wide screen", () => {
  afterEach(removeMatchMedia);

  it("renders an explicit Close button", () => {
    installMatchMedia(true);

    renderView();

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
