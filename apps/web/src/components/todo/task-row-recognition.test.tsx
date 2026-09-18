import type { Label, Project, Task } from "@meologue/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TaskRow } from "./task-row";

/**
 * jsdom implements neither method AT ALL on `Range` (verified directly —
 * `"getClientRects" in document.createRange()` is `false`) — `task-title-
 * editor.tsx`'s own `popupStyle` calls `EditorView.coordsAtPos` the
 * instant a popup is open, which reaches exactly this gap
 * (`prosemirror-view`'s own `singleRect`). `task-detail-view-
 * recognition.test.tsx`'s own identical shim has the fuller account;
 * repeated here rather than shared, since nothing else in this codebase
 * yet needs it and this file has no existing shared home for it.
 */
beforeAll(() => {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = (): DOMRectList => [] as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = (): DOMRect =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON() {
          return this;
        },
      }) as DOMRect;
  }
});

/**
 * Simulates typing into the real, mounted `TaskTitleEditor` without going
 * through jsdom's absent contenteditable engine — dispatched as a genuine
 * `paste` DOM event instead, which `prosemirror-view`'s own
 * `editHandlers.paste` handles entirely through
 * `view.state.tr.replaceSelection(...)`, never through the DOM's own
 * Selection/Range APIs. `task-detail-view-recognition.test.tsx`'s own
 * identical helper has the fuller verification story.
 */
function pasteText(target: HTMLElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  target.dispatchEvent(event);
  return event;
}

// `task-row.test.tsx`'s own factories, reused verbatim.
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
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
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
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

function renderRow(overrides: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const props = {
    task: task(),
    detailActions: {
      projects: [] as Project[],
      labels: [] as Label[],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetDate: vi.fn(),
      onSetDateString: vi.fn(),
      datesWithTasks: new Map(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      onRename: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
    isDropTarget: false,
    ...overrides,
  };
  render(
    <ul>
      <TaskRow {...props} />
    </ul>,
    { wrapper: MemoryRouter },
  );
  return props;
}

describe("#/@ autocomplete in the row's inline rename", () => {
  it("typing '#' opens the listbox with the supplied projects", async () => {
    renderRow({
      task: task({ content: "buy " }),
      detailActions: {
        projects: [project({ id: "p1", name: "Errands" })],
        labels: [] as Label[],
        onOpenDetail: vi.fn(),
        onSetPriority: vi.fn(),
        onSetDate: vi.fn(),
        onSetDateString: vi.fn(),
        datesWithTasks: new Map(),
        onSetProject: vi.fn(),
        onSetLabels: vi.fn(),
        onCopyLink: vi.fn(),
        onRename: vi.fn(),
        commentCountFor: vi.fn(() => 0),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: 'Edit "buy "' }));
    const titleEditor = await screen.findByLabelText("Task name");

    pasteText(titleEditor, "#");

    const listbox = await screen.findByRole("listbox");
    expect(listbox).toHaveAttribute("data-testid", "content-editor-suggestions-dropdown");
    expect(within(listbox).getByText("Errands")).toBeInTheDocument();
  });
});
