import type { Project, Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

// Issue #228: `TaskQuickFind` is a controlled dialog now — its own former
// document-level `/`/`f`/⌘K listener moved to `use-todo-keymap.ts` (that
// hook's own header comment on why it's the one listener now, not a second
// one racing it). This wrapper stands in for `todo-page.tsx`'s own
// `quickFindOpen` state, so these tests still drive open/close the way a
// reader actually would — by whatever calls `onOpenChange` — without
// re-testing the keymap hook's own trigger-key matching here (that lives
// in `use-todo-keymap.test.ts`).
function ControlledQuickFind(
  props: Omit<Parameters<typeof TaskQuickFind>[0], "open" | "onOpenChange"> & {
    initialOpen?: boolean;
  },
) {
  const { initialOpen = false, ...rest } = props;
  const [open, setOpen] = useState(initialOpen);
  return <TaskQuickFind {...rest} open={open} onOpenChange={setOpen} />;
}

function renderQuickFind(
  props: Partial<Parameters<typeof TaskQuickFind>[0]> & { initialOpen?: boolean } = {},
) {
  const onOpenTask = vi.fn();
  const onOpenProject = vi.fn();
  const onShowMoreResults = vi.fn();
  render(
    <ControlledQuickFind
      tasks={[]}
      projects={[]}
      onOpenTask={onOpenTask}
      onOpenProject={onOpenProject}
      onShowMoreResults={onShowMoreResults}
      initialOpen={true}
      {...props}
    />,
  );
  return { onOpenTask, onOpenProject, onShowMoreResults };
}

describe("TaskQuickFind", () => {
  it("renders nothing while `open` is false", () => {
    renderQuickFind({ initialOpen: false });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog while `open` is true — controlled entirely by the caller (issue #228)", () => {
    renderQuickFind({ initialOpen: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("matches a Task title by a mid-word fragment, highlighted", () => {
    renderQuickFind({ tasks: [task({ id: "a", content: "Buildzzzing" })] });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "uildz" } });

    const match = screen.getByText("uildz");
    expect(match.tagName).toBe("MARK");
  });

  it("matches Project names too, but never a completed Task", () => {
    renderQuickFind({
      tasks: [task({ id: "a", content: "done already", completedAt: "2026-01-01T00:00:00.000Z" })],
      projects: [project({ id: "p1", name: "Groceries" })],
    });

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

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("closes on Escape", () => {
    renderQuickFind();

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hands the query to onShowMoreResults and closes", () => {
    const { onShowMoreResults } = renderQuickFind({
      tasks: [task({ id: "a", content: "alpha task" })],
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByText(/Show more results/));

    expect(onShowMoreResults).toHaveBeenCalledWith("alpha");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
