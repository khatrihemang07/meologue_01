import type { Comment, Label, Project, Section, Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetailView } from "./task-detail-view";

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
    events: [],
    ...overrides,
  };
  render(<TaskDetailView {...props} />);
  return props;
}

describe("TaskDetailView", () => {
  it("renders as a dialog, carrying the Task's own title", () => {
    renderView({ task: task({ content: "call mum" }) });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Task title")).toHaveValue("call mum");
  });

  it("does not autofocus the title on open, so a phone doesn't pop the keyboard for a tap that's usually just a look", () => {
    renderView();

    expect(screen.getByLabelText("Task title")).not.toHaveFocus();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
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

  it("renaming commits on blur, trimmed", () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    const titleField = screen.getByLabelText("Task title");
    fireEvent.change(titleField, { target: { value: "  new title  " } });
    fireEvent.blur(titleField);

    expect(onRename).toHaveBeenCalledWith("new title");
  });

  it("does not commit a rename when the title is unchanged or blank", () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    const titleField = screen.getByLabelText("Task title");
    fireEvent.blur(titleField);
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.change(titleField, { target: { value: "   " } });
    fireEvent.blur(titleField);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("Enter commits the title without adding a newline", () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    const titleField = screen.getByLabelText("Task title");
    // The field no longer autofocuses on open (a phone would pop its
    // keyboard for a tap that's usually just a look), so this test
    // focuses it itself — a real edit starts with a tap, which focuses
    // the field the same way. Without this, jsdom's `.blur()` inside the
    // component's own Enter handler is a no-op against an element that
    // was never the `document.activeElement`, and `onRename` never fires.
    titleField.focus();
    fireEvent.change(titleField, { target: { value: "new title" } });
    fireEvent.keyDown(titleField, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("new title");
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

    it("tapping the pill opens an editable textarea seeded with the current text", () => {
      renderView({ task: task({ description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(screen.getByLabelText("Task description")).toHaveValue("existing text");
    });

    it("commits a new Description on blur, trimmed", () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: null }), onSetDescription });

      fireEvent.click(screen.getByRole("button", { name: "Description" }));
      const field = screen.getByLabelText("Task description");
      fireEvent.change(field, { target: { value: "  a plan\n\n- step one\n- step two  " } });
      fireEvent.blur(field);

      expect(onSetDescription).toHaveBeenCalledWith("a plan\n\n- step one\n- step two");
    });

    it("clearing a Description back to blank sets it to null", () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "something" }), onSetDescription });

      fireEvent.click(screen.getByText("something"));
      const field = screen.getByLabelText("Task description");
      fireEvent.change(field, { target: { value: "   " } });
      fireEvent.blur(field);

      expect(onSetDescription).toHaveBeenCalledWith(null);
    });

    it("does not commit when the text is unchanged", () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "unchanged" }), onSetDescription });

      fireEvent.click(screen.getByText("unchanged"));
      fireEvent.blur(screen.getByLabelText("Task description"));

      expect(onSetDescription).not.toHaveBeenCalled();
    });

    it("Escape reverts an in-progress edit without committing", () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "original" }), onSetDescription });

      fireEvent.click(screen.getByText("original"));
      const field = screen.getByLabelText("Task description");
      fireEvent.change(field, { target: { value: "discard me" } });
      fireEvent.keyDown(field, { key: "Escape" });
      fireEvent.blur(field);

      expect(onSetDescription).not.toHaveBeenCalled();
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

    it("Enter submits the composer; Shift+Enter does not", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      const field = screen.getByLabelText("Add a comment");
      fireEvent.change(field, { target: { value: "typed" } });
      fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
      expect(onAddComment).not.toHaveBeenCalled();

      fireEvent.keyDown(field, { key: "Enter" });
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

    it("deleting a Comment calls onRemoveComment with its id", () => {
      const onRemoveComment = vi.fn();
      renderView({ comments: [comment({ id: "c1" })], onRemoveComment });

      fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

      expect(onRemoveComment).toHaveBeenCalledWith("c1");
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
    it("shows the checkbox checked and the title struck through", () => {
      renderView({ task: task({ completedAt: "2026-01-02T00:00:00.000Z", content: "call mum" }) });

      const checkbox = screen.getByLabelText('Mark "call mum" not done');
      expect(checkbox).toBeChecked();
      expect(screen.getByLabelText("Task title")).toHaveClass("line-through");
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

    it("the title remains editable", () => {
      const onRename = vi.fn();
      renderView({ task: task({ completedAt: "2026-01-02T00:00:00.000Z" }), onRename });

      const field = screen.getByLabelText("Task title");
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.blur(field);

      expect(onRename).toHaveBeenCalledWith("changed");
    });
  });

  describe("an active Task", () => {
    it("shows the checkbox unchecked, with no strikethrough", () => {
      renderView({ task: task({ completedAt: null, content: "call mum" }) });

      const checkbox = screen.getByLabelText('Complete "call mum"');
      expect(checkbox).not.toBeChecked();
      expect(screen.getByLabelText("Task title")).not.toHaveClass("line-through");
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
