import type { Event, Project, Task } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { taskDetailPath } from "@/lib/task-detail-route";
import { ActivityFeed } from "./activity-feed";

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: "e1",
    deviceId: "device-a",
    eventType: "added",
    objectType: "task",
    objectId: "t1",
    taskId: "t1",
    projectId: null,
    occurredAt: new Date().toISOString(),
    extra: null,
    seq: 1,
    syncedAt: new Date().toISOString(),
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    deviceId: "device-a",
    content: "Buy milk",
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
    name: "Groceries",
    colour: "#808080",
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

describe("ActivityFeed", () => {
  it("shows an empty message when there is nothing to show", () => {
    render(<ActivityFeed events={[]} tasks={[]} projects={[]} />, { wrapper: MemoryRouter });
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });

  it("renders an Event grouped under today's own heading", () => {
    render(
      <ActivityFeed events={[event({ eventType: "added" })]} tasks={[task()]} projects={[]} />,
      {
        wrapper: MemoryRouter,
      },
    );
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("narrows to completions only when completedOnly is set", () => {
    render(
      <ActivityFeed
        events={[
          event({ id: "a", eventType: "added" }),
          event({ id: "b", eventType: "completed" }),
        ]}
        tasks={[task()]}
        projects={[]}
        completedOnly
      />,
      { wrapper: MemoryRouter },
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Completed");
  });

  // The coordinator's own gap-fix report: an activity row must name its
  // object — "Completed" alone is unusable in a feed that aggregates
  // across every Task, Project and Comment.
  it("names the Task an event is about", () => {
    render(
      <ActivityFeed events={[event({ eventType: "completed" })]} tasks={[task()]} projects={[]} />,
      { wrapper: MemoryRouter },
    );
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("Completed");
    expect(row.textContent).toContain("Buy milk");
  });

  // A Task event's own subject is a live link to that Task's own address.
  it("links a Task event's subject to that Task's own detail route", () => {
    const t = task({ id: "t9", content: "Water the plants" });
    render(
      <ActivityFeed
        events={[event({ objectId: "t9", taskId: "t9", eventType: "added" })]}
        tasks={[t]}
        projects={[]}
      />,
      { wrapper: MemoryRouter },
    );
    const link = screen.getByRole("link", { name: /Water the plants/ });
    expect(link).toHaveAttribute("href", taskDetailPath(t));
  });

  // ADR 0056 / entry-row.tsx's own Task Reference rule, applied to an
  // activity row: an object that no longer resolves (deleted, or not yet
  // Synced here) still renders a name — from the Event's own cached
  // label — never an empty phrase, and never a link to nowhere.
  it("still names a deleted Task's own Event, with no link", () => {
    render(
      <ActivityFeed
        events={[event({ eventType: "completed", extra: { content: "Long gone" } })]}
        tasks={[]}
        projects={[]}
      />,
      { wrapper: MemoryRouter },
    );
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("Long gone");
    expect(screen.queryByRole("link", { name: /Long gone/ })).not.toBeInTheDocument();
  });

  // task-detail-view.tsx's own Activity section — the one surface where
  // naming the Task is redundant, since the reader is already looking at
  // it.
  it("does not repeat the Task's own name on its own per-Task Activity view", () => {
    render(
      <ActivityFeed
        events={[event({ eventType: "completed", objectId: "t1", taskId: "t1" })]}
        tasks={[task()]}
        projects={[]}
        currentTaskId="t1"
      />,
      { wrapper: MemoryRouter },
    );
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("Completed");
    expect(row.textContent).not.toContain("Buy milk");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // A different Task's own Events (were this feed ever handed a mixed
  // scope) still name themselves even when `currentTaskId` is set.
  it("still names a Task that is not the one currentTaskId scopes to", () => {
    render(
      <ActivityFeed
        events={[event({ eventType: "completed", objectId: "other", taskId: "other" })]}
        tasks={[task({ id: "other", content: "Different Task" })]}
        projects={[]}
        currentTaskId="t1"
      />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByText(/Different Task/)).toBeInTheDocument();
  });

  it("resolves a moved Task's destination Project by name and links to it", () => {
    render(
      <ActivityFeed
        events={[
          event({
            eventType: "moved",
            extra: { projectId: "p1", lastProjectId: null, content: "Buy milk" },
          }),
        ]}
        tasks={[task()]}
        projects={[project()]}
      />,
      { wrapper: MemoryRouter },
    );
    const link = screen.getByRole("link", { name: /Groceries/ });
    expect(link).toHaveAttribute("href", "/todo/projects/p1");
  });

  it("names which Task a Comment event was made on", () => {
    render(
      <ActivityFeed
        events={[
          event({
            objectType: "comment",
            objectId: "c1",
            taskId: "t1",
            eventType: "added",
            extra: { text: "sounds good", taskContent: "Buy milk" },
          }),
        ]}
        tasks={[task()]}
        projects={[]}
      />,
      { wrapper: MemoryRouter },
    );
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("Commented on");
    expect(row.textContent).toContain("Buy milk");
  });
});
