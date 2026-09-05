import type { Filter, Project, Task } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterView, type FilterViewProps } from "./filter-view";

// FilterView reads "now" off the system clock (localDayKey(new Date())),
// the same way todo-page.tsx and today-view.tsx already do — mirrors
// today-view.test.tsx's own fake-timer setup so "today"/"overdue" fixture
// dates below are deterministic regardless of when this suite actually
// runs.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 10, 12, 0)); // Sep 10, 2026, local noon
});

afterEach(() => {
  vi.useRealTimers();
});

function filter(overrides: Partial<Filter> = {}): Filter {
  return {
    id: "filter-1",
    deviceId: "device-a",
    name: "Due today",
    colour: "#DC4C3E",
    query: "today",
    // Issue #196: updatedAt starts equal to createdAt
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
    id: "task-1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "A",
    dayOrder: "A",
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
    name: "Work",
    colour: "#DC4C3E",
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

function renderFilterView(overrides: Partial<FilterViewProps> = {}) {
  const props: FilterViewProps = {
    filter: null,
    tasks: [],
    projects: [],
    labels: [],
    listSections: vi.fn(async () => []),
    onCreate: vi.fn(() => "new-filter-id"),
    onRename: vi.fn(),
    onSetColour: vi.fn(),
    onSetQuery: vi.fn(async () => {}),
    onRemove: vi.fn(),
    onOpenTask: vi.fn(),
    ...overrides,
  };
  const queryClient = new QueryClient();
  return {
    props,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <FilterView {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("FilterView — creating a new Filter", () => {
  it("disables Save until a name and a parseable query are both present", () => {
    renderFilterView();

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows criterion 6's own error plainly, and keeps Save disabled, for a query that cannot be parsed", () => {
    renderFilterView();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter name" }), {
      target: { value: "My filter" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter query" }), {
      target: { value: "today & p1 | subtask" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/parentheses/i);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("enables Save once the name is non-empty and the query parses, and Save calls onCreate", () => {
    const onCreate = vi.fn(() => "new-filter-id");
    renderFilterView({ onCreate });

    fireEvent.change(screen.getByRole("textbox", { name: "Filter name" }), {
      target: { value: "My filter" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter query" }), {
      target: { value: "today" },
    });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);

    expect(onCreate).toHaveBeenCalledWith("My filter", "today", expect.any(String));
  });

  it("never shows a Remove Filter button before a Filter exists", () => {
    renderFilterView();

    expect(screen.queryByRole("button", { name: "Remove Filter" })).not.toBeInTheDocument();
  });
});

describe("FilterView — opening a saved Filter (criterion 1)", () => {
  it("pre-fills the name and query from the saved Filter", () => {
    renderFilterView({ filter: filter({ name: "Due today", query: "today" }) });

    expect(screen.getByRole("textbox", { name: "Filter name" })).toHaveValue("Due today");
    expect(screen.getByRole("textbox", { name: "Filter query" })).toHaveValue("today");
  });

  it("shows what it matches — a Task whose effective due day is today", () => {
    const dueToday = task({ id: "due-today", date: "2026-09-10" });
    renderFilterView({
      filter: filter({ query: "today" }),
      tasks: [dueToday],
    });

    expect(screen.getByText("buy milk")).toBeInTheDocument();
  });

  it("shows an empty-result message when nothing matches", () => {
    renderFilterView({ filter: filter({ query: "today" }), tasks: [] });

    expect(screen.getByText("No matching Tasks.")).toBeInTheDocument();
  });

  it("clicking a matching Task calls onOpenTask", () => {
    const onOpenTask = vi.fn();
    const dueToday = task({ id: "due-today", date: "2026-09-10", content: "call mum" });
    renderFilterView({ filter: filter({ query: "today" }), tasks: [dueToday], onOpenTask });

    fireEvent.click(screen.getByText("call mum"));

    expect(onOpenTask).toHaveBeenCalledWith(dueToday);
  });

  it("offers Remove Filter, opening a confirmation before calling onRemove (criterion-adjacent management, not a listed criterion but reachable)", () => {
    const onRemove = vi.fn();
    renderFilterView({ filter: filter(), onRemove });

    fireEvent.click(screen.getByRole("button", { name: "Remove Filter" }));
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe("FilterView — criterion 2, several result lists from one comma-separated query", () => {
  it("renders each list with its own label and count", () => {
    const overdueTask = task({ id: "overdue", date: "2026-01-01", content: "overdue task" });
    const dueTodayTask = task({ id: "today", date: "2026-09-10", content: "today task" });
    renderFilterView({
      filter: filter({ query: "overdue, today" }),
      tasks: [overdueTask, dueTodayTask],
    });

    expect(screen.getByText(/overdue · 1/)).toBeInTheDocument();
    expect(screen.getByText(/^today · 1/)).toBeInTheDocument();
    expect(screen.getByText("overdue task")).toBeInTheDocument();
    expect(screen.getByText("today task")).toBeInTheDocument();
  });
});

describe("FilterView — editing an existing Filter's query commits only when it parses", () => {
  it("commits a rename on blur", () => {
    const onRename = vi.fn();
    renderFilterView({ filter: filter({ name: "Old name" }), onRename });

    const nameInput = screen.getByRole("textbox", { name: "Filter name" });
    fireEvent.change(nameInput, { target: { value: "New name" } });
    fireEvent.blur(nameInput);

    expect(onRename).toHaveBeenCalledWith("New name");
  });

  it("commits a valid query edit on blur", async () => {
    const onSetQuery = vi.fn(async () => {});
    renderFilterView({ filter: filter({ query: "today" }), onSetQuery });

    const queryInput = screen.getByRole("textbox", { name: "Filter query" });
    fireEvent.change(queryInput, { target: { value: "overdue" } });
    fireEvent.blur(queryInput);

    // Fake timers are active (this file's own beforeEach) for a
    // deterministic "today" — `waitFor`'s own polling relies on a real
    // `setTimeout`, which fake timers freeze, so flushing the microtask
    // queue directly is what actually lets `commitQuery`'s single
    // `await onSetQuery(...)` resolve here.
    await Promise.resolve();
    await Promise.resolve();

    expect(onSetQuery).toHaveBeenCalledWith("overdue");
  });

  it("never commits an unparseable query edit on blur", () => {
    const onSetQuery = vi.fn(async () => {});
    renderFilterView({ filter: filter({ query: "today" }), onSetQuery });

    const queryInput = screen.getByRole("textbox", { name: "Filter query" });
    fireEvent.change(queryInput, { target: { value: "today & p1 | subtask" } });
    fireEvent.blur(queryInput);

    expect(onSetQuery).not.toHaveBeenCalled();
    // The error stays visible — the reader's broken text is never
    // silently discarded, only its commit is refused.
    expect(screen.getByRole("alert")).toHaveTextContent(/parentheses/i);
  });
});

describe("FilterView — Project/Label matching in the live preview", () => {
  it("matches a #Project predicate against the loaded Projects", () => {
    const work = project({ id: "work", name: "Work" });
    const inWork = task({ id: "in-work", projectId: "work", content: "invoice client" });
    renderFilterView({
      filter: filter({ query: "#Work" }),
      tasks: [inWork],
      projects: [work],
    });

    expect(screen.getByText("invoice client")).toBeInTheDocument();
  });
});
