import type { Label, Project, Task } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

// A real, stateful `open` — not a fixed prop with only a spy for
// `onOpenChange` — because issue #255's fix makes "Date…" open its popover
// only once this menu's own Content has genuinely closed (Radix's
// `onCloseAutoFocus`, fired when `Presence` actually tears the Content
// down). A fixed `open={true}` would never let that happen: Radix would
// have no `open` transition to react to at all.
function renderMenu(overrides: Partial<Parameters<typeof TaskCommandMenu>[0]> = {}) {
  const { open: initialOpen = true, onOpenChange: onOpenChangeSpy, ...rest } = overrides;
  const props = {
    task: task(),
    projects: [project()],
    labels: [label()],
    trigger: <button type="button">More</button>,
    onOpenDetail: vi.fn(),
    onOpenDate: vi.fn(),
    onSetPriority: vi.fn(),
    onSetProject: vi.fn(),
    onSetLabels: vi.fn(),
    onCopyLink: vi.fn(),
    onRequestDelete: vi.fn(),
    ...rest,
  };

  function Wrapper() {
    const [open, setOpen] = useState(initialOpen);
    return (
      <TaskCommandMenu
        {...props}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChangeSpy?.(next);
        }}
      />
    );
  }

  render(<Wrapper />);
  return props;
}

describe("keyboard hints on a touch-only device (issue #285)", () => {
  /** Stubs the two queries `keyboardLikely()` reads, plus hover for everything else. */
  function stubPointer({ coarse, hover }: { coarse: boolean; hover: boolean }) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches:
          (query === "(hover: hover)" && hover) ||
          (query === "(pointer: coarse)" && coarse) ||
          (query === "(hover: none)" && !hover),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  }

  it("renders no chord legend on a phone", () => {
    stubPointer({ coarse: true, hover: false });
    renderMenu();

    // The commands stay; only the legend for keys this reader cannot press
    // goes. Todoist Android shows no such legend — and no row menu at all.
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.queryByText("\u2318E")).toBeNull();
    expect(screen.queryByText(/\u2318\u232b|\u21e7Delete/)).toBeNull();
  });

  it("keeps the legend on a pointer device", () => {
    stubPointer({ coarse: false, hover: true });
    renderMenu();

    expect(screen.getByText("\u2318E")).toBeInTheDocument();
  });

  it("keeps the legend when a coarse pointer still hovers", () => {
    // The Tauri desktop window can report a coarse pointer for a trackpad —
    // `task-row-content.tsx` documents the same trap. Coarse alone must not
    // be read as "no keyboard".
    stubPointer({ coarse: true, hover: true });
    renderMenu();

    expect(screen.getByText("\u2318E")).toBeInTheDocument();
  });
});

describe("TaskCommandMenu", () => {
  it("Edit calls onOpenDetail", () => {
    const onOpenDetail = vi.fn();
    renderMenu({ onOpenDetail });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  // Issue #253: Date opens the row's own anchored `TaskSchedulePopover`
  // instance (`onOpenDate`) rather than the shared `TaskScheduleSheet` —
  // Deadline used to open that sheet through `onOpenSchedule`, but issue
  // #376 removed the "Deadline…" item (and `onOpenSchedule`) entirely.
  //
  // Issue #255: `onOpenDate` no longer fires synchronously from `onSelect`
  // — it now waits for this menu's own `onCloseAutoFocus`, which only
  // fires once Radix's `Presence` actually finishes closing the Content
  // (see that item's own doc comment in task-command-menu.tsx for why).
  // jsdom runs no real CSS animation, so `Presence` resolves quickly, but
  // still asynchronously — hence `waitFor` rather than a synchronous
  // assertion right after the click.
  it("Date opens the row's own scheduler popover through onOpenDate", async () => {
    const onOpenDate = vi.fn();
    renderMenu({ onOpenDate });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Date/ }));

    await waitFor(() => expect(onOpenDate).toHaveBeenCalledTimes(1));
  });

  // Issue #376's own acceptance criterion: no surface offers to set, edit,
  // clear or display a deadline — this menu no longer has a "Deadline…"
  // item at all, not merely one wired to nothing.
  it("has no Deadline item", () => {
    renderMenu();

    expect(screen.queryByRole("menuitem", { name: /^Deadline/ })).not.toBeInTheDocument();
  });

  it("Priority's own submenu writes the stored (inverted) value, never the UI number", () => {
    const onSetPriority = vi.fn();
    renderMenu({ onSetPriority });

    fireEvent.click(screen.getByRole("menuitem", { name: /^Priority/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "P1" }));

    // storedPriorityOf(1) === 4 — task-types.ts's own inversion.
    expect(onSetPriority).toHaveBeenCalledWith(4);
  });

  it("exposes the stored (inverted) priority as data-value on each picker item", () => {
    renderMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /^Priority/ }));

    expect(screen.getByRole("menuitem", { name: "P1" })).toHaveAttribute("data-value", "4");
    expect(screen.getByRole("menuitem", { name: "P2" })).toHaveAttribute("data-value", "3");
    expect(screen.getByRole("menuitem", { name: "P3" })).toHaveAttribute("data-value", "2");
    expect(screen.getByRole("menuitem", { name: "P4" })).toHaveAttribute("data-value", "1");
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
