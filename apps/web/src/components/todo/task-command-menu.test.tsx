import type { Label, Project, Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskCommandMenu } from "./task-command-menu";

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
    id: "p1",
    deviceId: "device-a",
    name: "Errands",
    colour: "#ff8d85",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    description: null,
    favourite: false,
    archived: false,
    parentId: null,
    orderKey: "V",
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

function renderMenu(overrides: Partial<Parameters<typeof TaskCommandMenu>[0]> = {}) {
  const props = {
    task: task(),
    projects: [project()],
    labels: [label()],
    open: true,
    onOpenChange: vi.fn(),
    trigger: <button type="button">More</button>,
    onOpenDetail: vi.fn(),
    onOpenSchedule: vi.fn(),
    onSetPriority: vi.fn(),
    onSetProject: vi.fn(),
    onSetLabels: vi.fn(),
    onCopyLink: vi.fn(),
    onRequestDelete: vi.fn(),
    ...overrides,
  };
  render(<TaskCommandMenu {...props} />);
  return props;
}

describe("TaskCommandMenu", () => {
  it("Edit calls onOpenDetail", () => {
    const onOpenDetail = vi.fn();
    renderMenu({ onOpenDetail });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  it("Date and Deadline both open the shared TaskScheduleSheet, not a picker of their own", () => {
    const onOpenSchedule = vi.fn();
    renderMenu({ onOpenSchedule });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Deadline/ }));

    expect(onOpenSchedule).toHaveBeenCalledTimes(2);
  });

  it("Priority's own submenu writes the stored (inverted) value, never the UI number", () => {
    const onSetPriority = vi.fn();
    renderMenu({ onSetPriority });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Priority/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "P1" }));

    // storedPriorityOf(1) === 4 — task-types.ts's own inversion.
    expect(onSetPriority).toHaveBeenCalledWith(4);
  });

  it("Move to…'s own submenu offers Inbox and every Project, and writes the chosen one", () => {
    const onSetProject = vi.fn();
    const errands = project({ id: "p1", name: "Errands" });
    renderMenu({ onSetProject, projects: [errands] });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Move to/ }));
    expect(screen.getByRole("menuitem", { name: "Inbox" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Errands" }));

    expect(onSetProject).toHaveBeenCalledWith("p1");
  });

  it("Labels' own submenu toggles a Label on and off the Task's own labelIds", () => {
    const onSetLabels = vi.fn();
    renderMenu({
      onSetLabels,
      labels: [label({ id: "l1", name: "Home" })],
      task: task({ labelIds: [] }),
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Labels" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Home" }));

    expect(onSetLabels).toHaveBeenCalledWith(["l1"]);
  });

  it("renders no Labels submenu when there are no Labels yet — no affordance for a picker with nothing to pick", () => {
    renderMenu({ labels: [] });

    expect(screen.queryByRole("menuitem", { name: "Labels" })).not.toBeInTheDocument();
  });

  it("Copy link to task calls onCopyLink", () => {
    const onCopyLink = vi.fn();
    renderMenu({ onCopyLink });

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link to task" }));

    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it("Delete calls onRequestDelete, behind the identical ConfirmDialog every other Delete in this app goes through", () => {
    const onRequestDelete = vi.fn();
    renderMenu({ onRequestDelete });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete/ }));

    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    renderMenu({ open: false });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // No Reminders, Duplicate or Open in new window — this file's own header
  // comment on why: none names a capability this codebase has.
  it("offers no Reminders, Duplicate or Open in new window item", () => {
    renderMenu();

    expect(screen.queryByText(/Reminder/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Duplicate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open in new window/)).not.toBeInTheDocument();
  });
});
