import type { Label, Project, Section, Task } from "@meologue/core";
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
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    date: null,
    deadline: null,
    duration: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
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
    onOpenSchedule: vi.fn(),
    onSetProject: vi.fn(),
    onSetLabels: vi.fn(),
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

  it("names description and comments as not built yet, rather than showing nothing", () => {
    renderView();

    expect(screen.getByText(/Description and comments aren't built yet/)).toBeInTheDocument();
  });

  it("shows no duration control anywhere — Task.duration is being removed in a concurrent ticket", () => {
    renderView();

    expect(screen.queryByText(/[Dd]uration/)).not.toBeInTheDocument();
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
