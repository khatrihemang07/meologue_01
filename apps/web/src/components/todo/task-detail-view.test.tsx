import type { Comment, Event, Label, Project, Section, Task } from "@meologue/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import { TaskDetailView } from "./task-detail-view";

vi.mock("@/components/ui/toast", () => {
  const toast = vi.fn() as unknown as typeof import("@/components/ui/toast").toast;
  return { toast };
});

function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
  commitOnBlur = true,
  autoFocus = true,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  commitOnBlur?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, mirroring the real editor's own mount-time focus.
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, []);
  return (
    <input
      ref={ref}
      aria-label={ariaLabel ?? "Task name"}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange?.(event.target.value);
      }}
      onBlur={() => {
        if (commitOnBlur) {
          onCommit(text);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit(text);
        }
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

/**
 * Stands in for the real `TaskDescriptionEditor` (issue #229) — the
 * identical "mock exactly the piece that needs a real browser" split
 * `StubTaskTitleEditor` above already takes, since it too wraps a real
 * ProseMirror `EditorView`.
 */
function StubTaskDescriptionEditor({
  value,
  onChange,
  onCancel,
  autoFocus = true,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, mirroring the real editor's own mount-time focus.
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, []);
  return (
    <textarea
      ref={ref}
      aria-label="Description"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

vi.mock("@/components/todo/task-description-editor", () => ({
  TaskDescriptionEditor: StubTaskDescriptionEditor,
}));

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
    onCopyLink: vi.fn(),
    onDelete: vi.fn(),
    onCompleteForever: vi.fn(),
    onOpenSchedule: vi.fn(),
    onSetDate: vi.fn(),
    onSetDateString: vi.fn(),
    datesWithTasks: new Map(),
    onSetProject: vi.fn(),
    onSetLabels: vi.fn(),
    onSetDescription: vi.fn(),
    comments: [],
    onAddComment: vi.fn(),
    onEditComment: vi.fn(),
    onRemoveComment: vi.fn(),
    subtasks: [],
    onAddSubtask: vi.fn(),
    onCompleteSubtask: vi.fn(),
    onUncompleteSubtask: vi.fn(),
    events: [],
    ...overrides,
  };
  // MemoryRouter: an Activity line links its subject, as it does in the app.
  const view = render(<TaskDetailView {...props} />, { wrapper: MemoryRouter });
  return {
    ...props,
    rerender: (nextOverrides: Partial<Parameters<typeof TaskDetailView>[0]> = {}) => {
      const nextProps = { ...props, ...nextOverrides };
      view.rerender(<TaskDetailView {...nextProps} />);
      return nextProps;
    },
  };
}

describe("TaskDetailView", () => {
  it("renders as a dialog, carrying the Task's own title as a display element, not an editor, at rest", () => {
    renderView({ task: task({ content: "call mum" }) });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("task-detail-title")).toBeInTheDocument();
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
  });

  it("renders markdown in the at-rest title as real formatting", () => {
    renderView({ task: task({ content: "ZZ probe **bold** _em_ `code`" }) });

    const title = screen.getByTestId("task-detail-title");
    expect(title).toHaveAttribute("tabindex", "-1");
    expect(title.querySelector("strong")?.textContent).toBe("bold");
    expect(title.querySelector("em")?.textContent).toBe("em");
    expect(title.querySelector("code")?.textContent).toBe("code");
  });

  it("still opens the editor on the raw, unrendered title", async () => {
    renderView({ task: task({ content: "ZZ probe **bold** _em_ `code`" }) });

    fireEvent.click(screen.getByTestId("task-detail-title"));

    expect(await screen.findByLabelText("Task name")).toHaveValue("ZZ probe **bold** _em_ `code`");
  });

  // Issue #398: a saved title's `[text](url)` renders as a live link at
  // rest, not the raw bracket syntax.
  it("renders a saved [text](url) title as a live link, and clicking it doesn't start editing", () => {
    renderView({ task: task({ content: "Read [my article](https://example.com/post)" }) });

    const link = screen.getByRole("link", { name: "my article" });
    expect(link).toHaveAttribute("href", "https://example.com/post");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Read my article");

    fireEvent.click(link);

    // Clicking the link must not ALSO start title editing — the title
    // `div`'s own `onClick` (task-detail-view.tsx's own comment) is what
    // "still opens the editor" above proves fires on an ordinary click;
    // this proves the link's own `stopPropagation` keeps it from firing
    // too.
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
  });

  it("names the task in its own Activity lines, and counts only lines it shows", async () => {
    const base = {
      deviceId: "device-a",
      objectType: "task",
      objectId: "1",
      taskId: "1",
      projectId: null,
      occurredAt: "2026-09-10T09:00:00.000Z",
      extra: null,
      syncedAt: "2026-09-10T09:00:00.000Z",
    } as const;
    const events: Event[] = [
      { ...base, id: "e1", seq: 1, eventType: "completed" },
      {
        ...base,
        id: "e2",
        seq: 2,
        eventType: "updated",
        objectType: "comment",
        objectId: "c1",
        extra: { text: "old" },
      },
    ];
    renderView({ task: task({ content: "call mum" }), events });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Task actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));

    const activityDialog = screen.getByRole("dialog", { name: "Activity (1)" });
    expect(
      within(activityDialog).getByRole("heading", { name: "Activity (1)" }),
    ).toBeInTheDocument();
    // `Activity (N)` renders synchronously — `renderableEvents` is computed
    // in this file, not read from `ActivityFeed` — but `ActivityFeed`
    // itself is now `lazy()` (`lazy-activity-feed.ts`), so its own content
    // (the `listitem` rows below) resolves after a tick behind the
    // `<Suspense>` fallback. `findAllByRole`, not `getAllByRole`.
    const lines = (await within(activityDialog).findAllByRole("listitem")).map(
      (item) => item.textContent ?? "",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("You completed");
    expect(lines[0]).toContain("call mum");
  });

  it("carries the data-testid on the dialog content", () => {
    renderView({ task: task({ content: "call mum" }) });

    expect(screen.getByTestId("task-details-modal")).toBe(screen.getByRole("dialog"));
  });

  it("does not autofocus the title on open, so a phone doesn't pop the keyboard for a tap that's usually just a look", () => {
    renderView({ task: task({ content: "call mum" }) });

    expect(screen.getByTestId("task-detail-title")).not.toHaveFocus();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("clicking the title activates the shared editor, seeded with the current content", async () => {
    renderView({ task: task({ content: "call mum" }) });

    fireEvent.click(screen.getByTestId("task-detail-title"));

    expect(await screen.findByLabelText("Task name")).toHaveValue("call mum");
  });

  describe("task-wide editing and the focus trap", () => {
    it("clicking the title activates BOTH the title and the description editors together, sharing one Cancel/Save pair", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByTestId("task-detail-title"));

      expect(await screen.findByLabelText("Task name")).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    it("clicking the description also activates BOTH editors together", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(await screen.findByLabelText("Task name")).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toBeInTheDocument();
    });

    it("clicking the description's own click target focuses the description, not the title", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(await screen.findByLabelText("Description")).toHaveFocus();
    });

    it("clicking the title (a generic entry point, not the description's own) focuses the title", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByTestId("task-detail-title"));

      expect(await screen.findByLabelText("Task name")).toHaveFocus();
    });

    it("a generic click in the gap between the title and Description editors focuses the dialog, not either field", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      const titleField = await screen.findByLabelText("Task name");
      expect(titleField).toHaveFocus();

      fireEvent.click(screen.getByTestId("task-detail-edit-column"));

      expect(titleField).not.toHaveFocus();
      expect(screen.getByLabelText("Description")).not.toHaveFocus();
      expect(screen.getByRole("dialog")).toHaveFocus();
    });

    it("clicking a descendant of the shared edit column (the title display, the Description block) does not re-target focus to the dialog", async () => {
      renderView({ task: task({ content: "call mum", description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(await screen.findByLabelText("Description")).toHaveFocus();
    });

    it("saves both the title and the description together from one Save click", async () => {
      const onRename = vi.fn();
      const onSetDescription = vi.fn();
      renderView({
        task: task({ content: "old title", description: "old text" }),
        onRename,
        onSetDescription,
      });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "new title" },
      });
      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "new text" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onRename).toHaveBeenCalledWith("new title");
      expect(onSetDescription).toHaveBeenCalledWith("new text");
    });

    it("Cancel with unsaved changes discards both drafts and returns to the display state, once Discard is confirmed", async () => {
      const onRename = vi.fn();
      const onSetDescription = vi.fn();
      renderView({
        task: task({ content: "old title", description: "old text" }),
        onRename,
        onSetDescription,
      });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      const confirmDialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(confirmDialog).getByRole("button", { name: "Discard" }));

      expect(onRename).not.toHaveBeenCalled();
      expect(onSetDescription).not.toHaveBeenCalled();
      expect(screen.getByTestId("task-detail-title")).toBeInTheDocument();
    });
  });

  describe("Cancel/Escape confirm first when there are unsaved changes", () => {
    it("Cancel with an unsaved title change asks before discarding, with Todoist's own wording and a Cancel/Discard pair", async () => {
      renderView({ task: task({ content: "old title" }) });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      const confirmDialog = await screen.findByRole("alertdialog");
      expect(within(confirmDialog).getByText("Discard unsaved changes?")).toBeInTheDocument();
      expect(
        within(confirmDialog).getByText("Your unsaved changes will be discarded."),
      ).toBeInTheDocument();
      expect(within(confirmDialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(within(confirmDialog).getByRole("button", { name: "Discard" })).toBeInTheDocument();

      // Nothing discarded yet — the draft is still sitting in the field
      // underneath, unlike the pre-fix behaviour this replaces.
      expect(screen.getByLabelText("Task name")).toHaveValue("discard me");
    });

    it("Cancelling the discard-confirmation dialog leaves the draft intact, still editing", async () => {
      renderView({ task: task({ content: "old title" }) });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const confirmDialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Task name")).toHaveValue("discard me");
      expect(screen.queryByTestId("task-detail-title")).not.toBeInTheDocument();
    });

    // The regression test for the keyboard-trap bug a first version of
    // this guard had: that version intercepted Escape at the `window`,
    // in capture phase, unconditionally while `editing` — which ran
    // ahead of EVERY layer, including this confirm dialog's own, so
    // Escape here just re-opened the same confirm instead of dismissing
    // it. Radix's `DismissableLayer` only wires its own `document`
    // Escape listener while a layer is topmost (this ticket's own report
    // has the source citation), so once the confirm is open, this
    // Content's `onEscapeKeyDown` above stops being called at all —
    // Escape reaches only the confirm's own (default) handling.
    it("Escape while the discard-confirmation is open dismisses ONLY the confirmation, not the whole view, leaving the draft intact", async () => {
      const onClose = vi.fn();
      renderView({ task: task({ content: "old title" }), onClose });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const confirmDialog = await screen.findByRole("alertdialog");

      fireEvent.keyDown(confirmDialog, { key: "Escape" });

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      // Still editing, draft intact — the confirm closed, the edit form
      // underneath did not.
      expect(screen.getByLabelText("Task name")).toHaveValue("discard me");
      expect(onClose).not.toHaveBeenCalled();
    });

    it("clicking Discard in the confirmation ends editing and discards the draft, without closing the whole view", async () => {
      const onClose = vi.fn();
      const onRename = vi.fn();
      renderView({ task: task({ content: "old title" }), onClose, onRename });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const confirmDialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(confirmDialog).getByRole("button", { name: "Discard" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
      expect(screen.getByTestId("task-detail-title")).toBeInTheDocument();
      expect(onRename).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Cancel with nothing changed discards immediately, with no confirmation", async () => {
      renderView({ task: task({ content: "old title" }) });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      await screen.findByLabelText("Task name");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByTestId("task-detail-title")).toBeInTheDocument();
    });

    it("Cancel with an unsaved Description-only change also asks first", async () => {
      renderView({ task: task({ content: "old title", description: "old text" }) });

      fireEvent.click(screen.getByText("old text"));
      fireEvent.change(await screen.findByLabelText("Description"), {
        target: { value: "discard me" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    });

    async function clickOutside(target: Element) {
      // Lets Radix's own mount-time `setTimeout(0)` (registering its
      // `document` pointerdown listener) run before the pointerdown below
      // — otherwise this dispatches into a listener that doesn't exist
      // yet, the identical race a real browser has for a click in the
      // same tick a dialog opens.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.pointerDown(target);
      fireEvent.click(target);
    }

    it("clicking away from the whole panel with unsaved changes asks first, and does not close the view", async () => {
      const onClose = vi.fn();
      renderView({ task: task({ content: "old title" }), onClose });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      await clickOutside(document.body);

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Task name")).toHaveValue("discard me");
    });

    it("clicking away from the whole panel with nothing changed cancels the edit silently, with no confirmation and no view-close", async () => {
      const onClose = vi.fn();
      renderView({ task: task({ content: "old title" }), onClose });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      await screen.findByLabelText("Task name");
      await clickOutside(document.body);

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByTestId("task-detail-title")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("a pointerdown INSIDE the panel while editing is left alone — the 'clicking away inside does nothing' stays true", async () => {
      renderView({ task: task({ content: "old title" }) });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      await screen.findByLabelText("Task name");
      fireEvent.pointerDown(screen.getByTestId("task-detail-edit-column"));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Task name")).toBeInTheDocument();
    });

    it("clicking Discard after an outside-click trigger closes the whole view too, matching Todoist", async () => {
      const onClose = vi.fn();
      const onRename = vi.fn();
      renderView({ task: task({ content: "old title" }), onClose, onRename });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "discard me" },
      });
      await clickOutside(document.body);
      const confirmDialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(confirmDialog).getByRole("button", { name: "Discard" }));

      expect(onRename).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
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

  it("renaming commits when the Save button is clicked, trimmed", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "  new title  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).toHaveBeenCalledWith("new title");
  });

  it("does not commit a rename when the title is unchanged or blank", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("blur alone does not commit or close the combined edit form", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "discard me" } });
    fireEvent.blur(titleField);

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId("task-detail-title")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task name")).toBeInTheDocument();
  });

  it("Enter commits the title without adding a newline", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "new title" } });
    fireEvent.keyDown(titleField, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("new title");
  });

  it("Escape with no unsaved changes cancels the in-progress edit and returns to the display title, without renaming", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.keyDown(titleField, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(await screen.findByTestId("task-detail-title")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Escape with an unsaved title change asks first instead of discarding immediately", async () => {
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onRename });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "discard me" } });
    fireEvent.keyDown(titleField, { key: "Escape" });

    const confirmDialog = await screen.findByRole("alertdialog");
    expect(within(confirmDialog).getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
    // Still editing underneath — nothing was discarded by the Escape itself.
    expect(screen.getByLabelText("Task name")).toHaveValue("discard me");

    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Discard" }));

    expect(await screen.findByTestId("task-detail-title")).toBeInTheDocument();
  });

  it("Escape while editing does not also close the whole Task view, whether or not there are unsaved changes", async () => {
    const onClose = vi.fn();
    renderView({ task: task({ content: "old title" }), onClose });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.keyDown(titleField, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("task-detail-title"));
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "discard me" } });
    fireEvent.keyDown(screen.getByLabelText("Task name"), { key: "Escape" });
    await screen.findByRole("alertdialog");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking Discard after an Escape trigger ends editing but does not close the whole view", async () => {
    const onClose = vi.fn();
    const onRename = vi.fn();
    renderView({ task: task({ content: "old title" }), onClose, onRename });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "discard me" } });
    fireEvent.keyDown(titleField, { key: "Escape" });
    const confirmDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Discard" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId("task-detail-title")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape inside the open confirmation returns focus to the Task name editor, with the draft intact", async () => {
    renderView({ task: task({ content: "old title" }) });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleField = await screen.findByLabelText("Task name");
    fireEvent.change(titleField, { target: { value: "discard me" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const confirmDialog = await screen.findByRole("alertdialog");

    fireEvent.keyDown(confirmDialog, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const titleFieldAfter = screen.getByLabelText("Task name");
    expect(titleFieldAfter).toHaveValue("discard me");

    // Radix's own `FocusScope` defers the close-autofocus dispatch by one
    // tick (`setTimeout(..., 0)` in its unmount cleanup, so the closing
    // container is fully out of the DOM first) — the identical async gap
    // this file's own `clickOutside` helper above already waits out for
    // Radix's outside-pointerdown listener, for the identical reason.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(titleFieldAfter).toHaveFocus();
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

  // Issue #253: Deadline and Priority still open the identical shared
  // schedule sheet; Date left it for its own anchored `TaskSchedulePopover`
  // instance instead — see the next test.
  it("Deadline and Priority open the identical shared schedule sheet", () => {
    const onOpenSchedule = vi.fn();
    renderView({ onOpenSchedule });

    fireEvent.click(screen.getByRole("button", { name: "Deadline" }));
    fireEvent.click(screen.getByRole("button", { name: "Priority" }));

    expect(onOpenSchedule).toHaveBeenCalledTimes(2);
  });

  // Issue #253: Date anchors its own `TaskSchedulePopover` instance
  // directly under the attribute pill/row — `scheduler-view` is the
  // popover's own `data-testid` (task-schedule-popover.tsx). jsdom lays
  // nothing out, so this proves the popover opens, not that it anchors;
  // see this ticket's own report for why anchoring needs a real browser.
  it("Date opens its own anchored scheduler popover, not the shared sheet", () => {
    const onOpenSchedule = vi.fn();
    renderView({ onOpenSchedule });

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Date" }));

    expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    expect(onOpenSchedule).not.toHaveBeenCalled();
  });

  it("picking a day from the Date popover calls onSetDate", () => {
    const onSetDate = vi.fn();
    renderView({ onSetDate });

    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    // The popover's own "Today" quick option — `/^Today \w{3}$/`, not a bare
    // `/^Today/`, because react-day-picker's default day-cell aria-label
    // for today's own calendar cell also starts with "Today, " (a comma
    // and the full weekday name), which would otherwise match too.
    fireEvent.click(screen.getByRole("button", { name: /^Today \w{3}$/ }));

    expect(onSetDate).toHaveBeenCalledWith("1", expect.any(String));
  });

  it("an unset Date/Deadline/Priority renders a pill; once set, each is promoted into its own row", () => {
    renderView({
      task: task({ date: "2026-09-03", priority: 4 }), // stored 4 is UI P1.
    });

    // Date is set — a promoted row naming its value, not a bare pill.
    expect(screen.getByRole("button", { name: /Date.*3 Sep/s })).toBeInTheDocument();
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

  describe("a toast when a rename resolves a Date", () => {
    // Pinned the same way task-detail-view-recognition.test.tsx's own
    // `beforeEach` is (that file's own comment on why `toFake: ["Date"]`
    // alone, not every timer: entering title-edit mode below goes through
    // `findByLabelText`, which polls with a REAL `setTimeout` — faking
    // every timer would hang that poll instead of resolving it).
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0));
      vi.mocked(toast).mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // This view's own contract (`onRename: (content: string) => void`)
    // never hands resolution back — `commitTaskTitle` (task-title-commit.ts)
    // runs one layer up, through a `useMutation` (hooks/use-tasks.ts's
    // `setDateMutation`), so this view only learns a Date resolved once its
    // parent re-renders it with the changed Task. `renderView`'s own
    // `rerender` (this file's header comment on it) stands in for that
    // later, external re-render.
    it("raises a toast naming the resolved Date, with a 10s duration, once the store's own write lands", async () => {
      const onRename = vi.fn();
      const { rerender } = renderView({
        task: task({ id: "1", content: "buy milk", date: null }),
        onRename,
      });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      const titleField = await screen.findByLabelText("Task name");
      fireEvent.change(titleField, { target: { value: "buy milk tomorrow" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onRename).toHaveBeenCalledWith("buy milk tomorrow");
      // Nothing has resolved yet — `onRename` is a bare mock here, exactly
      // as it is in every other test in this file; no toast until the
      // Task prop itself changes.
      expect(toast).not.toHaveBeenCalled();

      rerender({ task: task({ id: "1", content: "buy milk", date: "2026-09-14" }) });

      expect(toast).toHaveBeenCalledWith(
        "Date updated to Tomorrow",
        expect.objectContaining({
          duration: 10_000,
          action: expect.objectContaining({ label: "Undo", onClick: expect.any(Function) }),
        }),
      );
    });

    it("raises no toast when a rename does not change the Date", async () => {
      const onRename = vi.fn();
      const { rerender } = renderView({
        task: task({ id: "1", content: "buy milk", date: "2026-09-20" }),
        onRename,
      });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      const titleField = await screen.findByLabelText("Task name");
      fireEvent.change(titleField, { target: { value: "buy bread" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onRename).toHaveBeenCalledWith("buy bread");

      // The store's own write lands, but the rename never touched Date —
      // only `content` differs from the render before Save.
      rerender({ task: task({ id: "1", content: "buy bread", date: "2026-09-20" }) });

      expect(toast).not.toHaveBeenCalled();
    });

    it("Undo restores the previous Date and time, and never the title", async () => {
      const onRename = vi.fn();
      const onSetDate = vi.fn();
      const { rerender } = renderView({
        task: task({ id: "1", content: "buy milk", date: "2026-09-01T08:00" }),
        onRename,
        onSetDate,
      });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      const titleField = await screen.findByLabelText("Task name");
      fireEvent.change(titleField, { target: { value: "buy milk tomorrow" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      rerender({
        task: task({ id: "1", content: "buy milk", date: "2026-09-14" }),
        onSetDate,
      });

      const toastCall = vi.mocked(toast).mock.calls[0];
      const action = toastCall?.[1]?.action as { onClick: () => void } | undefined;
      action?.onClick();

      // The exact previous string, time-of-day included — never just the
      // day, and never a second call touching `content`.
      expect(onSetDate).toHaveBeenCalledWith("1", "2026-09-01T08:00");
      expect(onRename).toHaveBeenCalledTimes(1);
    });

    // Regression guard for the misattribution risk this file's own
    // `pendingRenameDateRef` doc comment names: a rename that never
    // touched the Date leaves that ref sitting unconsumed (`task.date`
    // never changed to not-match its snapshot), so a LATER, unrelated
    // Date edit must not be misread as the earlier rename's own effect.
    // `onPickDay` (task-detail-view.tsx, the Date attribute's own
    // popover) clears the ref before calling `onSetDate` specifically to
    // guard against this.
    it("does not raise a toast for an unrelated Date pick that follows a non-Date-changing rename", async () => {
      const onRename = vi.fn();
      const onSetDate = vi.fn();
      const { rerender } = renderView({
        task: task({ id: "1", content: "buy milk", date: null }),
        onRename,
        onSetDate,
      });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      const titleField = await screen.findByLabelText("Task name");
      fireEvent.change(titleField, { target: { value: "buy bread" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(onRename).toHaveBeenCalledWith("buy bread");

      // Store update lands: only `content` changed, Date stays null.
      rerender({ task: task({ id: "1", content: "buy bread", date: null }), onSetDate });
      expect(toast).not.toHaveBeenCalled();

      // The reader now picks a Date explicitly, through this view's own
      // Date attribute — a wholly separate action from the rename above.
      fireEvent.click(screen.getByRole("button", { name: "Date" }));
      fireEvent.click(screen.getByRole("button", { name: /^Today \w{3}$/ }));
      expect(onSetDate).toHaveBeenCalled();

      const pickedDay = vi.mocked(onSetDate).mock.calls[0]?.[1] as string;
      rerender({ task: task({ id: "1", content: "buy bread", date: pickedDay }), onSetDate });

      expect(toast).not.toHaveBeenCalled();
    });
  });

  describe("postponing a recurring Task keeps its rule", () => {
    /**
     * Driven on live Todoist 2026-09-15
     * (`recurrence-reschedule-todoist-2026-09-14.json`): rescheduling a
     * recurring task — by calendar click OR by quick option — leaves the
     * recurrence rule untouched, and completing it then computes
     * `max(current due, today) + one interval`. So the postponed date is
     * the real anchor. meologue used to clear `dateString` on every date
     * pick, which meant a postponed Task stopped repeating altogether.
     */
    it("picking a day leaves the recurrence in place", () => {
      const onSetDate = vi.fn();
      const onSetDateString = vi.fn();
      renderView({
        task: task({ id: "1", date: "2026-09-15", dateString: "every day" }),
        onSetDate,
        onSetDateString,
      });

      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Tomorrow \w{3}$/ }));

      expect(onSetDate).toHaveBeenCalled();
      // The whole defect: this used to fire with `null` and end the series.
      expect(onSetDateString).not.toHaveBeenCalled();
    });

    it("clearing the date with No Date still ends the recurrence — a rule has nothing left to count from", () => {
      const onSetDateString = vi.fn();
      renderView({
        task: task({ id: "1", date: "2026-09-15", dateString: "every day" }),
        onSetDateString,
      });

      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", null, expect.any(String));
    });

    it("a Task with no recurrence is unaffected either way", () => {
      const onSetDateString = vi.fn();
      renderView({
        task: task({ id: "1", date: "2026-09-15", dateString: null }),
        onSetDateString,
      });

      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Tomorrow \w{3}$/ }));

      expect(onSetDateString).not.toHaveBeenCalled();
    });
  });

  // Issue #296: both of this view's own `onSetDateString` call sites
  // (the "No Date" pick above and the Repeat menu below) used to thread
  // `new Date().toISOString()` through as the third argument —
  // `TaskStore.setDateString`'s own doc comment (packages/core) says that
  // parameter (`today`) has always meant a floating local calendar day,
  // never an instant. Slicing an instant's first ten characters names the
  // UTC day, not the Device's own, for a window each night as wide as the
  // Device's own UTC offset — the identical shape of bug issue #290 fixed
  // for `advanceRecurringTask`/`postponeTask` in use-tasks.ts. These tests
  // pin both directions the same way that fix's own use-tasks.test.tsx
  // suite does: a Device east of UTC before its own midnight has reached
  // UTC, and one west of UTC after local time has already rolled into
  // UTC's next day.
  describe("issue #296 — onSetDateString receives the local day, not UTC's", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it("clearing the date with No Date reports the local day for a Device east of UTC, before its own midnight has reached UTC", () => {
      vi.stubEnv("TZ", "Asia/Kolkata");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 15, 0, 16, 18));

      const onSetDateString = vi.fn();
      renderView({
        task: task({ id: "1", date: "2026-09-14", dateString: "every day" }),
        onSetDateString,
      });

      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", null, "2026-09-15");
    });

    it("clearing the date with No Date reports the local day for a Device west of UTC, once local time has already rolled into UTC's next day", () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 14, 23, 45, 0));

      const onSetDateString = vi.fn();
      renderView({
        task: task({ id: "1", date: "2026-09-13", dateString: "every day" }),
        onSetDateString,
      });

      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", null, "2026-09-14");
    });

    it("picking 'Every day' from the Repeat menu reports the local day for a Device east of UTC, before its own midnight has reached UTC", () => {
      vi.stubEnv("TZ", "Asia/Kolkata");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 15, 0, 16, 18));

      const onSetDateString = vi.fn();
      renderView({
        task: task({ id: "1", date: null, dateString: null }),
        onSetDateString,
      });

      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      // Radix's `DropdownMenu.Trigger` opens on `pointerdown`, not `click`
      // — task-schedule-popover.test.tsx's own `openRepeatMenu` helper
      // establishes this identically for the same "Repeat" button.
      fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
      const menu = screen.getByTestId("repeat-menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every day" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", "every day", "2026-09-15");
    });

    it("picking 'Every day' from the Repeat menu reports the local day for a Device west of UTC, once local time has already rolled into UTC's next day", () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 14, 23, 45, 0));

      const onSetDateString = vi.fn();
      renderView({
        task: task({ id: "1", date: null, dateString: null }),
        onSetDateString,
      });

      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
      const menu = screen.getByTestId("repeat-menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every day" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", "every day", "2026-09-14");
    });
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

    it("tapping the pill opens the shared description editor, seeded with the current text", async () => {
      renderView({ task: task({ description: "existing text" }) });

      fireEvent.click(screen.getByText("existing text"));

      expect(await screen.findByLabelText("Description")).toHaveValue("existing text");
    });

    it("commits a new Description when Save is clicked, trimmed", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: null }), onSetDescription });

      fireEvent.click(screen.getByRole("button", { name: "Description" }));
      const field = await screen.findByLabelText("Description");
      fireEvent.change(field, { target: { value: "  a plan\n\n- step one\n- step two  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onSetDescription).toHaveBeenCalledWith("a plan\n\n- step one\n- step two");
    });

    it("clearing a Description back to blank sets it to null", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "something" }), onSetDescription });

      fireEvent.click(screen.getByText("something"));
      const field = await screen.findByLabelText("Description");
      fireEvent.change(field, { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onSetDescription).toHaveBeenCalledWith(null);
    });

    it("does not commit when the text is unchanged", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "unchanged" }), onSetDescription });

      fireEvent.click(screen.getByText("unchanged"));
      await screen.findByLabelText("Description");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onSetDescription).not.toHaveBeenCalled();
    });

    it("Escape with no unsaved changes reverts an in-progress edit without committing", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "original" }), onSetDescription });

      fireEvent.click(screen.getByText("original"));
      const field = await screen.findByLabelText("Description");
      fireEvent.keyDown(field, { key: "Escape" });

      expect(onSetDescription).not.toHaveBeenCalled();
      expect(screen.getByText("original")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("Escape with an unsaved Description change asks first instead of discarding immediately", async () => {
      const onSetDescription = vi.fn();
      renderView({ task: task({ description: "original" }), onSetDescription });

      fireEvent.click(screen.getByText("original"));
      const field = await screen.findByLabelText("Description");
      fireEvent.change(field, { target: { value: "discard me" } });
      fireEvent.keyDown(field, { key: "Escape" });

      const confirmDialog = await screen.findByRole("alertdialog");
      expect(onSetDescription).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Description")).toHaveValue("discard me");

      fireEvent.click(within(confirmDialog).getByRole("button", { name: "Discard" }));

      expect(await screen.findByText("original")).toBeInTheDocument();
    });
  });

  describe("Comments — issue #180", () => {
    function openCommentOptions(itemName: string, index = 0) {
      const trigger = screen.getAllByRole("button", { name: "Comment options" })[index];
      if (trigger === undefined) {
        throw new Error(`no Comment options trigger at index ${index}`);
      }
      fireEvent.pointerDown(trigger);
      fireEvent.click(screen.getByRole("menuitem", { name: itemName }));
    }

    it("renders no Comments section at all when there are none — not an empty heading", () => {
      renderView({ comments: [] });

      // Todoist's own zero state, read back from its live DOM
      // (`detail-modal-todoist-2026-09-14.json`'s
      // `comments.zeroCommentsState`): the word "Comments" appears nowhere
      // in the left column when the Task has none. meologue used to render
      // a bare "Comments" heading over nothing.
      expect(screen.queryByText(/^Comments/)).not.toBeInTheDocument();
    });

    it("lists every Comment, oldest first as handed in, each rendered as Markdown", () => {
      renderView({
        comments: [
          comment({ id: "c1", text: "first *reply*" }),
          comment({ id: "c2", text: "second reply" }),
        ],
      });

      expect(screen.getByText("Comments 2")).toBeInTheDocument();
      expect(screen.getByText("reply", { selector: "em" })).toBeInTheDocument();
      expect(screen.getByText("second reply")).toBeInTheDocument();
    });

    it("a Comment's own bare URL renders as a real link, opened safely in a new tab", () => {
      renderView({
        comments: [comment({ id: "c1", text: "see https://example.com now" })],
      });

      const link = screen.getByRole("link", { name: "https://example.com" });
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    function openComposer() {
      fireEvent.click(screen.getByRole("button", { name: "Open comment editor" }));
      return screen.getByLabelText("Add a comment");
    }

    it("submitting adds a Comment, clears the field, and leaves the composer open for the next one", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      const field = openComposer();
      fireEvent.change(field, { target: { value: "  a new comment  " } });
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));

      expect(onAddComment).toHaveBeenCalledWith("a new comment");
      expect(field).toHaveValue("");
      // Todoist does not re-collapse after a submit — driven and read back.
      expect(screen.getByLabelText("Add a comment")).toBeInTheDocument();
    });

    it("Ctrl/Cmd+Enter submits — plain Enter and Shift+Enter do not (the opposite of the task composer)", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      const field = openComposer();
      fireEvent.change(field, { target: { value: "typed" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onAddComment).not.toHaveBeenCalled();

      fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
      expect(onAddComment).not.toHaveBeenCalled();

      fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
      expect(onAddComment).toHaveBeenCalledWith("typed");
    });

    it("Cmd+Enter (metaKey) also submits", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      const field = openComposer();
      fireEvent.change(field, { target: { value: "typed" } });
      fireEvent.keyDown(field, { key: "Enter", metaKey: true });

      expect(onAddComment).toHaveBeenCalledWith("typed");
    });

    it("ignores a blank comment — the submit is never disabled, so the guard is in the handler", () => {
      const onAddComment = vi.fn();
      renderView({ comments: [], onAddComment });

      openComposer();
      const submit = screen.getByRole("button", { name: "Comment" });
      // Measured on Todoist in both states: never `disabled`, never greyed.
      expect(submit).not.toBeDisabled();
      fireEvent.click(submit);

      expect(onAddComment).not.toHaveBeenCalled();
    });

    it("editing a Comment opens a textarea seeded with its text", () => {
      renderView({ comments: [comment({ id: "c1", text: "original" })] });

      openCommentOptions("Edit");
      const field = screen.getByLabelText("Edit comment");
      expect(field).toHaveValue("original");
    });

    it("blurring the editor (clicking away) leaves it open with the draft intact, and saves nothing — Todoist's model, where only Cancel/Update decide the edit's fate", () => {
      const onEditComment = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onEditComment });

      openCommentOptions("Edit");
      const field = screen.getByLabelText("Edit comment");
      field.focus();
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.blur(field);

      expect(onEditComment).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Edit comment")).toHaveValue("changed");
    });

    it("Escape discards the draft and closes the editor without saving (regression — see this commit's own message for the bug this replaced)", () => {
      const onEditComment = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onEditComment });

      openCommentOptions("Edit");
      const field = screen.getByLabelText("Edit comment");
      // Focused, exactly like a reader who has actually been typing —
      // the bug this guards against only shows up once the textarea is
      // the real `document.activeElement`, which is what makes the
      // Escape handler's own `.blur()` call fire a genuine blur event.
      field.focus();
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.keyDown(field, { key: "Escape" });

      expect(onEditComment).not.toHaveBeenCalled();
      expect(screen.queryByRole("textbox", { name: "Edit comment" })).not.toBeInTheDocument();
      expect(screen.getByText("original")).toBeInTheDocument();
    });

    it("Escape cancelling a Comment edit closes only the inline editor, not the whole task-detail dialog (regression — the keydown used to bubble to Radix Dialog's own close handler)", () => {
      const onClose = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onClose });

      openCommentOptions("Edit");
      const field = screen.getByLabelText("Edit comment");
      field.focus();
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.keyDown(field, { key: "Escape" });

      // The editor closed (the same assertion the test above already
      // makes) — what this test adds is that the DIALOG survived it: the
      // exact same `role="dialog"` node is still on screen, and `onClose`
      // (this view's own signal that Radix decided to dismiss it) was
      // never called.
      expect(screen.queryByRole("textbox", { name: "Edit comment" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Escape still closes the dialog when no Comment editor is open — the fix above is scoped to editing, not a blanket swallow of every Escape in this view", () => {
      const onClose = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onClose });

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Cancel discards the draft and closes the editor without saving", () => {
      const onEditComment = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onEditComment });

      openCommentOptions("Edit");
      const field = screen.getByLabelText("Edit comment");
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onEditComment).not.toHaveBeenCalled();
      expect(screen.queryByRole("textbox", { name: "Edit comment" })).not.toBeInTheDocument();
      expect(screen.getByText("original")).toBeInTheDocument();
    });

    it("Update commits the trimmed draft and closes the editor", () => {
      const onEditComment = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onEditComment });

      openCommentOptions("Edit");
      const field = screen.getByLabelText("Edit comment");
      fireEvent.change(field, { target: { value: "  changed  " } });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));

      expect(onEditComment).toHaveBeenCalledWith("c1", "changed");
      expect(screen.queryByRole("textbox", { name: "Edit comment" })).not.toBeInTheDocument();
    });

    it("Update saves nothing for a blank draft or one identical to the original", () => {
      const onEditComment = vi.fn();
      renderView({ comments: [comment({ id: "c1", text: "original" })], onEditComment });

      openCommentOptions("Edit");
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      expect(onEditComment).not.toHaveBeenCalled();
      expect(screen.getByText("original")).toBeInTheDocument();

      openCommentOptions("Edit");
      const field = screen.getByLabelText("Edit comment");
      fireEvent.change(field, { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      expect(onEditComment).not.toHaveBeenCalled();
      expect(screen.getByText("original")).toBeInTheDocument();
    });

    it("deleting a Comment asks for confirmation first, and does not remove until confirmed", () => {
      const onRemoveComment = vi.fn();
      renderView({ comments: [comment({ id: "c1" })], onRemoveComment });

      openCommentOptions("Delete");

      // Not removed yet — the confirm dialog is open, not the delete itself.
      expect(onRemoveComment).not.toHaveBeenCalled();
      expect(screen.getByText("Delete comment?")).toBeInTheDocument();
      expect(screen.getByText("This comment will be permanently deleted.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      expect(onRemoveComment).toHaveBeenCalledWith("c1");
    });

    it("Cancelling the delete confirmation removes nothing", () => {
      const onRemoveComment = vi.fn();
      renderView({ comments: [comment({ id: "c1" })], onRemoveComment });

      openCommentOptions("Delete");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onRemoveComment).not.toHaveBeenCalled();
    });

    describe("the composer is collapsed at rest", () => {
      it("shows a 'Comment' bar and no field until it is opened", () => {
        renderView({ comments: [] });

        const bar = screen.getByRole("button", { name: "Open comment editor" });
        expect(bar).toHaveTextContent("Comment");
        expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
      });

      it("opens on click, with focus landing directly in the field", () => {
        renderView({ comments: [] });

        const field = openComposer();

        expect(field).toBeInTheDocument();
        expect(document.activeElement).toBe(field);
      });

      it("issue #306: openCommentComposer=true starts expanded, with focus already in the field — no click needed", () => {
        renderView({ comments: [], openCommentComposer: true });

        expect(
          screen.queryByRole("button", { name: "Open comment editor" }),
        ).not.toBeInTheDocument();
        const field = screen.getByLabelText("Add a comment");
        expect(field).toBeInTheDocument();
        expect(document.activeElement).toBe(field);
      });

      it("issue #306: openCommentComposer left unset (or false) stays collapsed at rest", () => {
        renderView({ comments: [], openCommentComposer: false });
        expect(screen.getByRole("button", { name: "Open comment editor" })).toBeInTheDocument();
        expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
      });

      it("opens from the keyboard — the bar is a real button, so Enter activates it", () => {
        renderView({ comments: [] });

        const bar = screen.getByRole("button", { name: "Open comment editor" });
        bar.focus();
        expect(document.activeElement).toBe(bar);
        fireEvent.click(bar); // what Enter on a focused <button> dispatches

        expect(document.activeElement).toBe(screen.getByLabelText("Add a comment"));
      });

      it("Escape on an EMPTY field collapses it and returns focus to the bar", () => {
        renderView({ comments: [] });

        const field = openComposer();
        field.focus();
        fireEvent.keyDown(window, { key: "Escape" });

        expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Open comment editor" })).toBeInTheDocument();
      });

      it("Escape with TEXT only blurs — it does not collapse, ask, or discard", () => {
        const onAddComment = vi.fn();
        renderView({ comments: [], onAddComment });

        const field = openComposer();
        fireEvent.change(field, { target: { value: "half-written" } });
        field.focus();
        fireEvent.keyDown(window, { key: "Escape" });

        // Still open, still holding the draft, nothing asked.
        expect(screen.getByLabelText("Add a comment")).toHaveValue("half-written");
        expect(document.activeElement).not.toBe(field);
        expect(screen.queryByText(/discard/i)).not.toBeInTheDocument();
      });

      it("a SECOND Escape is left for the dialog — the composer stops claiming the key once focus has left the field", () => {
        const onClose = vi.fn();
        renderView({ comments: [], onClose });

        const field = openComposer();
        fireEvent.change(field, { target: { value: "half-written" } });
        field.focus();
        fireEvent.keyDown(window, { key: "Escape" }); // stage one: blur only

        // Stage two: focus is no longer in the field, so this listener must
        // not stop the event — that is the whole mechanism, and it is what
        // lets Radix close the Task modal on the next press.
        // Dispatched on `body`, not on `window`: an event fired AT `window`
        // only runs `window`'s own listeners, so it could never prove
        // anything about what reaches `document`. Firing from the element
        // focus actually sits on is what the browser really does, and it
        // travels window -> document -> target the same way Radix sees it.
        let reachedDocument = false;
        document.addEventListener(
          "keydown",
          () => {
            reachedDocument = true;
          },
          { capture: true },
        );
        fireEvent.keyDown(document.body, { key: "Escape" });

        expect(reachedDocument).toBe(true);
      });

      it("Cancel is a different path from Escape: it collapses AND discards on the first click", () => {
        renderView({ comments: [] });

        const field = openComposer();
        fireEvent.change(field, { target: { value: "half-written" } });
        fireEvent.click(screen.getByRole("button", { name: "Close comment editor" }));

        expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
        // Reopening shows an empty field — Cancel truly discards.
        expect(openComposer()).toHaveValue("");
      });
    });

    describe("the Comments header collapses", () => {
      it("is a real disclosure, open by default, and collapses the thread", () => {
        renderView({ comments: [comment({ id: "c1", text: "first" })] });

        // `closest("details")` rather than `getByRole("group", { name })`:
        // a `<details>` does take the role, but testing-library does not
        // compute its accessible name from the `<summary>`, so the named
        // query finds nothing. Checked directly before writing this.
        const summary = screen.getByText("Comments 1");
        const disclosure = summary.closest("details");
        expect(disclosure).toHaveAttribute("open");
        expect(screen.getByText("first")).toBeInTheDocument();

        fireEvent.click(summary);

        expect(disclosure).not.toHaveAttribute("open");
      });

      it("counts the Comments in its summary, bare and always plural, as Todoist does", () => {
        renderView({
          comments: [comment({ id: "c1" }), comment({ id: "c2" }), comment({ id: "c3" })],
        });

        expect(screen.getByText("Comments 3")).toBeInTheDocument();
        expect(screen.queryByText(/Comments \(/)).not.toBeInTheDocument();
      });

      it("does not singularise at one Comment — Todoist reads 'Comments 1', never 'Comment 1'", () => {
        renderView({ comments: [comment({ id: "c1" })] });

        expect(screen.getByText("Comments 1")).toBeInTheDocument();
      });

      it("keeps the pinned composer reachable while the thread is collapsed", () => {
        renderView({ comments: [comment({ id: "c1", text: "first" })] });

        fireEvent.click(screen.getByText("Comments 1"));

        expect(screen.getByRole("button", { name: "Open comment editor" })).toBeInTheDocument();
      });

      // jsdom lays nothing out, so this cannot assert the composer's actual
      // on-screen position (the fix this test accompanies is a geometry
      // fix, verified in a real browser instead — see the PR). What it DOES
      // prove, honestly: the scroller carries the class that makes it size
      // to its content rather than force-growing to fill the column
      // (`sm:flex-initial`, not `sm:flex-1`), and the composer's trigger
      // still comes after that scroller in DOM order, i.e. it remains the
      // column's footer rather than moving inside the scrolling region.
      it("className/DOM-order check only — the scroller no longer carries flex-1, and the composer stays its sibling footer", () => {
        renderView({ comments: [comment({ id: "c1", text: "first" })] });

        const scroller = screen.getByTestId("task-detail-edit-column");
        expect(scroller.className).toContain("sm:flex-initial");
        expect(scroller.className).not.toMatch(/(?:^|\s)sm:flex-1(?:\s|$)/);

        const composerTrigger = screen.getByRole("button", { name: "Open comment editor" });
        // DOCUMENT_POSITION_FOLLOWING: the composer's trigger sits after
        // the scroller in document order, i.e. as a later sibling, not a
        // descendant nested inside it.
        expect(
          scroller.compareDocumentPosition(composerTrigger) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(scroller.contains(composerTrigger)).toBe(false);
      });
    });

    describe("the Comment options menu", () => {
      // This project sets neither `unstubGlobals` nor `restoreMocks`
      // (vite.config.ts's own `test` block), so a stubbed `navigator` would
      // otherwise stay stubbed for every test after it in this file.
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("carries exactly Todoist's four visible items, in its order", () => {
        renderView({ comments: [comment({ id: "c1" })] });

        fireEvent.pointerDown(screen.getByRole("button", { name: "Comment options" }));

        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
          "Edit",
          "Copy text",
          "Copy link to comment",
          "Delete",
        ]);
      });

      it("has no 'Add a reaction' — this app has no user identity for a reaction to belong to", () => {
        renderView({ comments: [comment({ id: "c1" })] });

        fireEvent.pointerDown(screen.getByRole("button", { name: "Comment options" }));

        expect(screen.queryByRole("menuitem", { name: "Add a reaction" })).not.toBeInTheDocument();
      });

      it("Copy text copies the Comment's own Markdown source, not its rendered prose", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
        renderView({ comments: [comment({ id: "c1", text: "a *bold* claim" })] });

        openCommentOptions("Copy text");

        expect(writeText).toHaveBeenCalledWith("a *bold* claim");
      });

      it("Copy link to comment copies this Task's own address, fragment-scoped to the Comment", () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
        renderView({
          task: task({ id: "11111111-1111-4111-8111-111111111111", content: "Buy milk" }),
          comments: [comment({ id: "c1" })],
        });

        openCommentOptions("Copy link to comment");

        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}/todo/task/buy-milk-11111111-1111-4111-8111-111111111111#comment-c1`,
        );
      });

      it("opens the menu belonging to the Comment it was triggered from", () => {
        const onRemoveComment = vi.fn();
        renderView({
          comments: [comment({ id: "c1", text: "first" }), comment({ id: "c2", text: "second" })],
          onRemoveComment,
        });

        openCommentOptions("Delete", 1);
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        expect(onRemoveComment).toHaveBeenCalledWith("c2");
      });
    });
  });

  describe("Sub-tasks — issue #229", () => {
    it("renders no count when there are no sub-tasks yet", () => {
      renderView({ subtasks: [] });

      expect(screen.getByText("Sub-tasks")).toBeInTheDocument();
      expect(screen.queryByText(/^Sub-tasks \(/)).not.toBeInTheDocument();
    });

    // Renamed from "struck through once completed": whether a completed
    // sub-task is struck through is the reader's own setting to make
    // (#237), and this surface arrived hardcoding it. What the list owes
    // is that a completed sub-task is MARKED as completed, through the one
    // class index.css drives, and an active one is not.
    it("lists every sub-task, marked completed once completed", () => {
      renderView({
        subtasks: [
          task({ id: "s1", content: "buy eggs", completedAt: null }),
          task({ id: "s2", content: "wash the car", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
      });

      expect(screen.getByText("Sub-tasks (2)")).toBeInTheDocument();
      expect(screen.getByText("buy eggs")).not.toHaveClass("completed-task-text");
      expect(screen.getByText("wash the car")).toHaveClass("completed-task-text");
      expect(screen.getByText("wash the car")).not.toHaveClass("line-through");
    });

    it("completing/uncompleting a sub-task calls the matching handler with its id", () => {
      const onCompleteSubtask = vi.fn();
      const onUncompleteSubtask = vi.fn();
      renderView({
        subtasks: [
          task({ id: "s1", content: "buy eggs", completedAt: null }),
          task({ id: "s2", content: "wash the car", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
        onCompleteSubtask,
        onUncompleteSubtask,
      });

      fireEvent.click(screen.getByLabelText('Complete "buy eggs"'));
      fireEvent.click(screen.getByLabelText('Mark "wash the car" not done'));

      expect(onCompleteSubtask).toHaveBeenCalledWith("s1");
      expect(onUncompleteSubtask).toHaveBeenCalledWith("s2");
    });

    it("adding a sub-task submits the typed text and clears the field", () => {
      const onAddSubtask = vi.fn();
      renderView({ onAddSubtask });

      const field = screen.getByLabelText("Add sub-task");
      fireEvent.change(field, { target: { value: "  water the plants  " } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(onAddSubtask).toHaveBeenCalledWith("water the plants");
      expect(field).toHaveValue("");
    });

    it("ignores a blank sub-task", () => {
      const onAddSubtask = vi.fn();
      renderView({ onAddSubtask });

      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(onAddSubtask).not.toHaveBeenCalled();
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
    // Issue #237: the title used to hardcode `text-muted-foreground
    // line-through` unconditionally on a completed Task, bypassing the
    // "Completed checklist item" setting (`data-completed-style`,
    // index.css) that History/Composer already honour.
    // `.completed-task-text` is the shared class index.css's one rule now
    // also reads — asserting it (and that the old hardcoded class is gone)
    // is what would catch a regression back to hardcoding. jsdom applies
    // no real cascade, so this only proves the class is present/absent,
    // not the resulting decoration or colour.
    it("shows the checkbox checked and gives the title the shared completed-style class", () => {
      renderView({ task: task({ completedAt: "2026-01-02T00:00:00.000Z", content: "call mum" }) });

      const checkbox = screen.getByLabelText('Mark "call mum" not done');
      expect(checkbox).toBeChecked();
      const title = screen.getByTestId("task-detail-title");
      expect(title).toHaveClass("completed-task-text");
      expect(title).not.toHaveClass("line-through");
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

    it("the title remains editable", async () => {
      const onRename = vi.fn();
      renderView({ task: task({ completedAt: "2026-01-02T00:00:00.000Z" }), onRename });

      fireEvent.click(screen.getByTestId("task-detail-title"));
      const field = await screen.findByLabelText("Task name");
      fireEvent.change(field, { target: { value: "changed" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(onRename).toHaveBeenCalledWith("changed");
    });
  });

  describe("an active Task", () => {
    it("shows the checkbox unchecked, with no strikethrough", () => {
      renderView({ task: task({ completedAt: null, content: "call mum" }) });

      const checkbox = screen.getByLabelText('Complete "call mum"');
      expect(checkbox).not.toBeChecked();
      const title = screen.getByTestId("task-detail-title");
      expect(title).not.toHaveClass("line-through");
      expect(title).not.toHaveClass("completed-task-text");
    });

    it("clicking the checkbox calls onComplete", () => {
      const onComplete = vi.fn();
      renderView({ task: task({ completedAt: null, content: "call mum" }), onComplete });

      fireEvent.click(screen.getByLabelText('Complete "call mum"'));

      expect(onComplete).toHaveBeenCalled();
    });
  });

  // Issue #302 — the header's own `⋮` overflow menu. `fireEvent.pointerDown`
  // then `fireEvent.click` mirrors `task-row.test.tsx`'s identical Radix
  // `DropdownMenu` pattern for the row's own "More actions" menu.
  describe("Issue #302 — the detail sheet's own overflow menu", () => {
    function openOverflow() {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Task actions" }));
    }

    it("carries an overflow control in the header, reachable by touch", () => {
      renderView();

      expect(screen.getByRole("button", { name: "Task actions" })).toBeInTheDocument();
    });

    it("offers Copy link to task, which calls onCopyLink", () => {
      const onCopyLink = vi.fn();
      renderView({ onCopyLink });

      openOverflow();
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy link to task" }));

      expect(onCopyLink).toHaveBeenCalledTimes(1);
    });

    it("Delete task confirms first — selecting it alone never calls onDelete", () => {
      const onDelete = vi.fn();
      renderView({ task: task({ content: "buy milk" }), onDelete });

      openOverflow();
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete task" }));

      expect(onDelete).not.toHaveBeenCalled();
      // `ConfirmDialog` renders `role="alertdialog"`, not `"dialog"`
      // (alert-dialog.tsx's own comment on why) — genuinely distinct from
      // this view's own outer `role="dialog"`, so this query can only ever
      // match the confirmation, never the sheet itself.
      expect(screen.getByRole("alertdialog", { name: "Delete task?" })).toBeInTheDocument();
    });

    it("confirming the Delete task dialog calls onDelete, matching the row menu's own confirm-first delete", () => {
      const onDelete = vi.fn();
      renderView({ task: task({ content: "buy milk" }), onDelete });

      openOverflow();
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete task" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("does not offer Complete forever for a non-recurring Task", () => {
      renderView({ task: task({ dateString: null }) });

      openOverflow();

      expect(screen.queryByRole("menuitem", { name: "Complete forever" })).not.toBeInTheDocument();
    });

    it("offers Complete forever for a recurring Task, and it ends the series without deleting it", () => {
      const onCompleteForever = vi.fn();
      const onDelete = vi.fn();
      renderView({ task: task({ dateString: "every day" }), onCompleteForever, onDelete });

      openOverflow();
      fireEvent.click(screen.getByRole("menuitem", { name: "Complete forever" }));

      expect(onCompleteForever).toHaveBeenCalledTimes(1);
      expect(onDelete).not.toHaveBeenCalled();
    });

    it("shows when the Task was added", () => {
      // Noon UTC (this suite's own established "safe" instant —
      // history.test.tsx's identical `T12:00:00.000Z` convention) so the
      // calendar day this asserts holds under any real local timezone;
      // the clock half is intentionally left unasserted digit-for-digit,
      // since that half genuinely does vary with the runner's own
      // timezone, correctly so.
      renderView({ task: task({ createdAt: "2026-08-26T12:00:00.000Z" }) });

      openOverflow();

      expect(screen.getByText(/^Added on 26 Aug \d{1,2}:\d{2}\s?[AP]M$/)).toBeInTheDocument();
    });
  });

  describe("Issue #288 — Activity moves behind View activity, not off the feed", () => {
    function openOverflow() {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Task actions" }));
    }

    // Todoist's own menu order (this ticket's own brief): Copy link to
    // task, then View activity, then Delete task.
    it("offers View activity in the overflow menu, after Copy link to task and before Delete task", () => {
      renderView();

      openOverflow();

      const names = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
      expect(names).toContain("View activity");
      const copyIndex = names.indexOf("Copy link to task");
      const activityIndex = names.indexOf("View activity");
      const deleteIndex = names.indexOf("Delete task");
      expect(activityIndex).toBeGreaterThan(copyIndex);
      expect(deleteIndex).toBeGreaterThan(activityIndex);
    });

    // The relative order holds regardless of whether "Complete forever"
    // (a meologue-only item Todoist's own menu has no equivalent of) is
    // present too — View activity's position is anchored to Copy
    // link/Delete, not to that item.
    it("keeps View activity between Copy link and Delete even when Complete forever is present", () => {
      renderView({ task: task({ dateString: "every day" }) });

      openOverflow();

      const names = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
      expect(names).toContain("Complete forever");
      const copyIndex = names.indexOf("Copy link to task");
      const activityIndex = names.indexOf("View activity");
      const deleteIndex = names.indexOf("Delete task");
      expect(activityIndex).toBeGreaterThan(copyIndex);
      expect(deleteIndex).toBeGreaterThan(activityIndex);
    });

    // The defect this ticket fixes: at rest, on the detail screen, a
    // Comment must appear exactly once — never a second time inside an
    // always-adjacent Activity disclosure quoting the same text.
    it("renders a Comment exactly once at rest — not a second time in an inline Activity disclosure", () => {
      const commentText = "ZZ probe comment shown only once";
      renderView({
        task: task({ id: "1", content: "call mum" }),
        comments: [comment({ id: "c1", taskId: "1", text: commentText })],
        events: [
          {
            id: "e1",
            deviceId: "device-a",
            objectType: "comment",
            eventType: "added",
            objectId: "c1",
            taskId: "1",
            projectId: null,
            occurredAt: "2026-09-10T09:00:00.000Z",
            extra: { text: commentText },
            syncedAt: "2026-09-10T09:00:00.000Z",
            seq: 1,
          },
        ],
      });

      expect(screen.getAllByText(commentText)).toHaveLength(1);
      // The old inline disclosure is gone outright, not merely collapsed
      // — its own "Activity (N)" summary text is nowhere on the detail
      // screen until "View activity" is opened.
      expect(screen.queryByText(/^Activity \(/)).not.toBeInTheDocument();
    });

    it("still shows comment events once View activity is opened", () => {
      const commentText = "ZZ probe comment shown only once";
      renderView({
        task: task({ id: "1", content: "call mum" }),
        comments: [comment({ id: "c1", taskId: "1", text: commentText })],
        events: [
          {
            id: "e1",
            deviceId: "device-a",
            objectType: "comment",
            eventType: "added",
            objectId: "c1",
            taskId: "1",
            projectId: null,
            occurredAt: "2026-09-10T09:00:00.000Z",
            extra: { text: commentText },
            syncedAt: "2026-09-10T09:00:00.000Z",
            seq: 1,
          },
        ],
      });

      openOverflow();
      fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));

      const activityDialog = screen.getByRole("dialog", { name: "Activity (1)" });
      const activityLines = within(activityDialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent ?? "");
      expect(activityLines).toHaveLength(1);
      expect(activityLines[0]).toContain("You commented");
      expect(activityLines[0]).toContain(commentText);
      // Now two: the thread row (still on screen underneath) and this
      // one, inside the dialog that's open on top of it — both are
      // legitimate, unlike the at-rest double-render this ticket fixes.
      expect(screen.getAllByText(commentText)).toHaveLength(2);
    });

    // Live-measured regression (code review, confirmed in a real browser):
    // Task actions -> View activity -> Escape left `document.activeElement`
    // on `BODY` while the detail dialog was still open. `Task actions` ->
    // `View activity` -> Escape must instead land back on `Task actions` —
    // the control the reader was actually on, not the top of the document.
    it("Escape inside View activity returns focus to the Task actions trigger, not document.body", async () => {
      renderView();

      openOverflow();
      fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));
      const activityDialog = screen.getByRole("dialog", { name: "Activity (0)" });
      // The overflow `DropdownMenu` that opened this dialog has ALSO just
      // unmounted, and its own `FocusScope` queues an identical deferred
      // (`setTimeout(..., 0)`) restore back to its own trigger — the same
      // `Task actions` button this test is about to check. Left pending,
      // that stale, unrelated timer would fire during the wait below and
      // land on the right element for the WRONG reason, masking a missing
      // `onCloseAutoFocus` on `TaskActivityDialog` itself (confirmed by
      // deliberately breaking it and watching this test stay green until
      // this settle was added — see this ticket's own commit message). A
      // real reader never presses Escape in the same tick the menu closed,
      // so this settles that leftover timer first, matching real timing,
      // before the dialog itself is ever dismissed.
      await new Promise((resolve) => setTimeout(resolve, 0));

      fireEvent.keyDown(activityDialog, { key: "Escape" });

      expect(screen.queryByRole("dialog", { name: "Activity (0)" })).not.toBeInTheDocument();
      // Radix's own `FocusScope` defers the close-autofocus dispatch by one
      // tick (`setTimeout(..., 0)` in its unmount cleanup) — the identical
      // async gap this file's own `clickOutside` helper, and the "Escape
      // inside the open confirmation" test above, already wait out for the
      // identical reason: a real gap inside Radix, not a jsdom quirk.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Task actions" }));
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

  // Issue #302's own acceptance criterion: the narrow (bottom-sheet) shell
  // specifically has to carry the overflow control, stated explicitly here
  // rather than left implicit — CLAUDE.md's own "breakpoint trap" note
  // names exactly this suite (task-schedule-popover.test.tsx's 59
  // assertions silently changed subject) as the reason a query broad
  // enough to match both shells proves nothing on its own. `matchMedia` is
  // pinned to `false` in THIS test, not inherited from the global stub
  // (`test/setup.ts`) or the wide-screen default this same describe block
  // already overrides for its sibling above.
  it("BREAKPOINT: narrow (<900px, bottom sheet) — the overflow control is present and opens the menu", () => {
    installMatchMedia(false);

    renderView();

    const trigger = screen.getByRole("button", { name: "Task actions" });
    expect(trigger).toBeInTheDocument();

    fireEvent.pointerDown(trigger);

    expect(screen.getByRole("menuitem", { name: "Copy link to task" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete task" })).toBeInTheDocument();
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
