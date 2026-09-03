import type { Project, Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskQuickFind } from "./task-quick-find";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
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
    id: "project-1",
    deviceId: "device-a",
    name: "Personal",
    colour: "#ff0000",
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

function renderQuickFind(props: Partial<Parameters<typeof TaskQuickFind>[0]> = {}) {
  const onOpenTask = vi.fn();
  const onOpenProject = vi.fn();
  const onShowMoreResults = vi.fn();
  render(
    <TaskQuickFind
      tasks={[]}
      projects={[]}
      onOpenTask={onOpenTask}
      onOpenProject={onOpenProject}
      onShowMoreResults={onShowMoreResults}
      {...props}
    />,
  );
  return { onOpenTask, onOpenProject, onShowMoreResults };
}

describe("TaskQuickFind", () => {
  it("is closed until its keyboard shortcut is pressed", () => {
    renderQuickFind();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on '/', 'f' and Ctrl+K", () => {
    renderQuickFind();

    fireEvent.keyDown(document, { key: "/" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "f" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not open on '/' or 'f' while typing in a text field", () => {
    render(
      <div>
        <input aria-label="somewhere else" />
        <TaskQuickFind
          tasks={[]}
          projects={[]}
          onOpenTask={vi.fn()}
          onOpenProject={vi.fn()}
          onShowMoreResults={vi.fn()}
        />
      </div>,
    );

    const otherInput = screen.getByLabelText("somewhere else");
    otherInput.focus();
    fireEvent.keyDown(otherInput, { key: "/" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("matches a Task title by a mid-word fragment, highlighted", () => {
    renderQuickFind({ tasks: [task({ id: "a", content: "Buildzzzing" })] });

    fireEvent.keyDown(document, { key: "/" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "uildz" } });

    const match = screen.getByText("uildz");
    expect(match.tagName).toBe("MARK");
  });

  it("matches Project names too, but never a completed Task", () => {
    renderQuickFind({
      tasks: [task({ id: "a", content: "done already", completedAt: "2026-01-01T00:00:00.000Z" })],
      projects: [project({ id: "p1", name: "Groceries" })],
    });

    fireEvent.keyDown(document, { key: "/" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "groc" } });

    expect(screen.getByText("Groc")).toBeInTheDocument();
    expect(screen.queryByText("done already")).not.toBeInTheDocument();
  });

  it("opens the highlighted result with ArrowDown then Enter", () => {
    const onOpenTask = vi.fn();
    renderQuickFind({
      tasks: [task({ id: "a", content: "alpha task" }), task({ id: "b", content: "alpha second" })],
      onOpenTask,
    });

    fireEvent.keyDown(document, { key: "/" });
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("closes on Escape", () => {
    renderQuickFind();

    fireEvent.keyDown(document, { key: "/" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hands the query to onShowMoreResults and closes", () => {
    const { onShowMoreResults } = renderQuickFind({
      tasks: [task({ id: "a", content: "alpha task" })],
    });

    fireEvent.keyDown(document, { key: "/" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByText(/Show more results/));

    expect(onShowMoreResults).toHaveBeenCalledWith("alpha");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
