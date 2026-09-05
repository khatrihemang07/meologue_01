import type { Comment, Project, Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TaskSearchPage } from "./task-search-page";

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

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "comment-1",
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

function renderPage(
  props: Partial<Parameters<typeof TaskSearchPage>[0]> = {},
  initialEntries: string[] = ["/todo/search"],
) {
  const onOpenTask = vi.fn();
  const onUncompleteTask = vi.fn();
  const { container } = render(
    <MemoryRouter initialEntries={initialEntries}>
      <TaskSearchPage
        tasks={[]}
        completedTasks={[]}
        comments={[]}
        projects={[]}
        onOpenTask={onOpenTask}
        onUncompleteTask={onUncompleteTask}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onOpenTask, onUncompleteTask, container };
}

describe("TaskSearchPage", () => {
  it("prompts to type before any query is entered", () => {
    renderPage();

    expect(screen.getByText(/Type to search/)).toBeInTheDocument();
  });

  it("finds a Task by a fragment from the middle of a word, in its title", () => {
    renderPage({ tasks: [task({ id: "a", content: "Buildzzzing" })] }, ["/todo/search?q=uildz"]);

    expect(screen.getByText("Buildzzzing")).toBeInTheDocument();
  });

  it("finds a Task by a word only in its Description", () => {
    renderPage(
      { tasks: [task({ id: "a", content: "plan the trip", description: "remember passports" })] },
      ["/todo/search?q=passport"],
    );

    expect(screen.getByText("plan the trip")).toBeInTheDocument();
  });

  it("does not span the title and the Description in one query", () => {
    renderPage(
      {
        tasks: [task({ id: "a", content: "desc-task", description: "carries uniqbetaword here" })],
      },
      ["/todo/search?q=desc-task%20uniqbetaword"],
    );

    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("never renders a <mark>, unlike the Quick-find dropdown", () => {
    const { container } = renderPage({ tasks: [task({ id: "a", content: "Buildzzzing" })] }, [
      "/todo/search?q=uildz",
    ]);

    expect(container.querySelector("mark")).toBeNull();
  });

  it("shows the Project as the breadcrumb, defaulting to Inbox", () => {
    renderPage(
      {
        tasks: [task({ id: "a", content: "filed task", projectId: "project-1" })],
        projects: [project({ id: "project-1", name: "Groceries" })],
      },
      ["/todo/search?q=filed"],
    );

    expect(screen.getByText("Groceries")).toBeInTheDocument();
  });

  it("excludes a completed Task until Show completed is switched on", () => {
    renderPage(
      {
        completedTasks: [
          task({ id: "a", content: "uniqzetaword", completedAt: "2026-01-05T00:00:00.000Z" }),
        ],
      },
      ["/todo/search?q=uniqzetaword"],
    );

    expect(screen.queryByText("uniqzetaword")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show completed"));

    expect(screen.getByText("uniqzetaword")).toBeInTheDocument();
  });

  it("switches to whole-word matching once Show completed is on, for every result", () => {
    renderPage({ tasks: [task({ id: "a", content: "uniqzetaword" })] }, [
      "/todo/search?q=zetaword",
    ]);

    expect(screen.getByText("uniqzetaword")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show completed"));

    expect(screen.queryByText("uniqzetaword")).not.toBeInTheDocument();
  });

  it("un-completes a completed result from its own checkbox", () => {
    const { onUncompleteTask } = renderPage(
      {
        completedTasks: [
          task({ id: "a", content: "finished thing", completedAt: "2026-01-05T00:00:00.000Z" }),
        ],
      },
      ["/todo/search?q=finished&completed=1"],
    );

    fireEvent.click(screen.getByLabelText("Mark as not done"));

    expect(onUncompleteTask).toHaveBeenCalledWith("a");
  });

  it("opens a Task result", () => {
    const { onOpenTask } = renderPage({ tasks: [task({ id: "a", content: "open me" })] }, [
      "/todo/search?q=open",
    ]);

    fireEvent.click(screen.getByText("open me"));

    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("switches to the Comments tab and finds a Comment, answering separately from Tasks", () => {
    renderPage(
      {
        tasks: [task({ id: "a", content: "a Task with no matching words" })],
        comments: [comment({ id: "c1", taskId: "a", text: "let's schedule a follow-up" })],
      },
      ["/todo/search?q=hedul"],
    );

    expect(screen.getByText("No matches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Comments" }));

    expect(screen.getByText("let's schedule a follow-up")).toBeInTheDocument();
  });
});
