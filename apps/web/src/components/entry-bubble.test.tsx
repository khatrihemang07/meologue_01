import type { Entry, Task } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SWIPE_TARGET_ATTRIBUTE } from "@/hooks/use-swipe-actions";
import { formatTaskReference } from "@/lib/inline-markdown";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { EntryBubble } from "./entry-bubble";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    body: "Ran the loop again this morning.",
    createdAt: "2026-08-27T09:15:00.000Z",
    updatedAt: "2026-08-27T09:15:00.000Z",
    deletedAt: null,
    seq: 1,
    ...overrides,
  } as Entry;
}

function bubbleOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="bubble"]');
  if (!el) throw new Error("no bubble rendered");
  return el;
}

describe("EntryBubble", () => {
  it("renders the Entry's own words", () => {
    render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    expect(screen.getByText("Ran the loop again this morning.")).toBeInTheDocument();
  });

  // The defect treatment F left behind: with both sides full width and told
  // apart only by a tint, a Question and its Answer are hard to scan apart.
  it("insets each side from the opposite edge, so the two are told apart by position", () => {
    const { container: out } = render(
      <EntryBubble entry={entry()} syncEnabled={false} side="out" />,
    );
    expect(bubbleOf(out).className).toContain("justify-end");
    expect(bubbleOf(out).className).toContain("pl-[12%]");

    const { container: incoming } = render(
      <EntryBubble entry={entry({ id: "e2" })} syncEnabled={false} side="in" />,
    );
    expect(bubbleOf(incoming).className).toContain("justify-start");
    expect(bubbleOf(incoming).className).toContain("pr-[12%]");
  });

  it("marks its side for anything styling or asserting against it", () => {
    const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="in" />);

    expect(bubbleOf(container)).toHaveAttribute("data-side", "in");
  });

  // A run of bubbles from one side reads as one turn of writing; a change of
  // side is the boundary worth spacing apart.
  it("groups tightly against the bubble above it, and loosely when it starts a run", () => {
    const { container: grouped } = render(
      <EntryBubble entry={entry()} syncEnabled={false} side="out" groupedWithPrevious />,
    );
    expect(bubbleOf(grouped).className).toContain("mt-0.5");

    const { container: fresh } = render(
      <EntryBubble entry={entry({ id: "e3" })} syncEnabled={false} side="out" />,
    );
    expect(bubbleOf(fresh).className).toContain("mt-3");
  });

  // Issue #149: the clock moved off a right float (which needed the body
  // to stay one line box) onto its own row below it, so an Entry can later
  // hold block content without breaking the float. The meta row is a
  // sibling of the body element, not nested inside it, and right-aligns
  // its own contents rather than relying on float placement to do it.
  it("puts the clock time on its own row below the body, right-aligned", () => {
    const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    // A `<div>`, not `<p>` (issue #152): the body can now render a `<ul>`/
    // `<ol>` alongside its own `<p>`s when the Entry holds a list, and a
    // list cannot validly nest inside a `<p>` — see entry-bubble.tsx's own
    // comment on this element.
    const body = container.querySelector('[data-slot="bubble-body"]');
    expect(body?.tagName).toBe("DIV");

    const meta = container.querySelector("time")?.parentElement;
    expect(meta).not.toBeNull();
    expect(meta?.className).not.toContain("float-right");
    expect(meta?.className).toContain("justify-end");
    // A sibling of the body, not inside it — its own row, not folded into
    // the body's own line box.
    expect(meta?.parentElement).toBe(body?.parentElement);
    expect(body?.contains(meta as Node)).toBe(false);
  });

  it("shows the not-yet-synced marker only when Sync is on and the Entry has not landed", () => {
    const pending = entry({ seq: null });

    const { rerender } = render(<EntryBubble entry={pending} syncEnabled={false} side="out" />);
    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();

    rerender(<EntryBubble entry={pending} syncEnabled={true} side="out" />);
    expect(screen.getByLabelText("Not yet synced")).toBeInTheDocument();

    rerender(<EntryBubble entry={entry({ seq: 4 })} syncEnabled={true} side="out" />);
    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  // Grounding renders Entries too, read-only (CONTEXT.md). A bubble with no
  // actions must offer none rather than offering them disabled.
  it("offers no Edit or Delete when no actions are wired", () => {
    render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  // #127. The marking and the `touch-action` go together: without the
  // attribute the recogniser never picks the bubble up, and without
  // `pan-y` Chromium's own scroll recogniser claims the drag before any
  // handler sees the second move — the same thing `pane-divider.tsx` needs
  // `touch-action: none` for, on the other axis.
  it("marks itself as something a finger can swipe, and leaves the vertical axis to the browser", () => {
    const { container } = render(
      <EntryBubble
        entry={entry({ id: "e7" })}
        syncEnabled={false}
        side="out"
        actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer: vi.fn(), onOpenSheet: vi.fn() }}
      />,
    );

    const target = container.querySelector<HTMLElement>(`[${SWIPE_TARGET_ATTRIBUTE}]`);
    expect(target).not.toBeNull();
    expect(target).toHaveClass("touch-pan-y");
    // The id is how history.tsx turns the element the gesture hands back
    // into the Entry the sheet opens for.
    expect(target?.dataset.entryId).toBe("e7");
  });

  it("marks nothing swipeable when no actions are wired", () => {
    const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    expect(container.querySelector(`[${SWIPE_TARGET_ATTRIBUTE}]`)).toBeNull();
  });

  // Issue #143: history.tsx's own signal that a followed Entry Reference's
  // seek just landed on this row. The flash lives on the fill (the div
  // `bubbleOf`'s first child is — same one `SWIPE_TARGET_ATTRIBUTE` marks
  // above), not the outer wrapper `bubbleOf` itself checks elsewhere in this
  // file, because that's the box with an actual visible edge to ring.
  describe("highlighted", () => {
    it("rings the bubble's fill when highlighted", () => {
      const { container } = render(
        <EntryBubble entry={entry()} syncEnabled={false} side="out" highlighted />,
      );

      expect(bubbleOf(container).firstElementChild).toHaveClass("ring-2");
    });

    it("stays plain, by default, with no seek in flight", () => {
      const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

      expect(bubbleOf(container).firstElementChild).not.toHaveClass("ring-2");
    });
  });

  // Issue #153: EntryBubble is where an id and a body land together, so
  // this is where `onToggleTask`'s per-Entry closure gets built —
  // `entry-prose.test.tsx` already covers the checkbox rendering and
  // marker-offset behaviour this wraps; these tests only cover the wiring
  // this file itself owns.
  describe("onToggleTask", () => {
    it("renders the checkbox disabled with no handler wired", () => {
      render(
        <EntryBubble entry={entry({ body: "- [ ] call mum" })} syncEnabled={false} side="out" />,
      );

      expect(screen.getByRole("checkbox")).toBeDisabled();
    });

    it("calls the handler with the Entry and the marker's own offsets", () => {
      const onToggleTask = vi.fn();
      const body = "- [ ] call mum";
      const withTask = entry({ body });
      render(
        <EntryBubble entry={withTask} syncEnabled={false} side="out" onToggleTask={onToggleTask} />,
      );

      fireEvent.click(screen.getByRole("checkbox"));

      expect(onToggleTask).toHaveBeenCalledTimes(1);
      const [calledEntry, markerFrom, markerTo] = onToggleTask.mock.calls[0] ?? [];
      expect(calledEntry).toBe(withTask);
      expect(body.slice(markerFrom, markerTo)).toBe("[ ]");
    });
  });

  // Issue #173, ADR 0048's write half — `TaskReferenceItem` (entry-row.tsx),
  // rendered here through History's own interactive path (`EntryBubble`,
  // reached via `entryBodyContent`'s fourth argument, `entry.id`). Needs
  // `useEntryStore()`, unlike every other test above in this file, so this
  // describe block alone stands the component up inside the router/query
  // wiring `entry-row.test.tsx`'s own `renderEntryRow` already established
  // for the identical reason.
  describe("a task reference", () => {
    const taskId = "0192abcd-1234-7890-abcd-0123456789ac";

    function taskFixture(overrides: Partial<Task> = {}): Task {
      return {
        id: taskId,
        deviceId: "device-a",
        content: "buy milk",
        completedAt: null,
        orderKey: "V",
        createdAt: "2026-01-01T00:00:00.000Z",
        seq: null,
        syncedAt: null,
        deletedAt: null,
        date: null,
        deadline: null,
        priority: 1,
        labelIds: [],
        dateString: null,
        projectId: null,
        sectionId: null,
        parentId: null,
        ...overrides,
      };
    }

    function renderEntryBubble(
      target: Entry,
      overrides: Partial<EntryStoreOutletContext> = {},
      queryClient = new QueryClient(),
    ) {
      const context: EntryStoreOutletContext = {
        entries: [],
        pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
        sendEntry: vi.fn(),
        search: vi.fn(async () => []),
        getEntries: vi.fn(async () => []),
        editEntry: vi.fn(),
        commitEntryEdit: vi.fn(),
        removeEntry: vi.fn(),
        tasks: [],
        completedTasks: [],
        addTask: vi.fn(),
        completeTask: vi.fn(),
        uncompleteTask: vi.fn(),
        renameTask: vi.fn(),
        reorderTask: vi.fn(),
        removeTask: vi.fn(),
        setTaskDate: vi.fn(),
        setTaskDeadline: vi.fn(),
        setTaskPriority: vi.fn(),
        setTaskLabels: vi.fn(),
        listTasksInProject: vi.fn(async () => []),
        listTaskChildren: vi.fn(async () => []),
        listTasksInSection: vi.fn(async () => []),
        listTaskDescendants: vi.fn(async () => []),
        advanceRecurringTask: vi.fn(),
        completeForeverTask: vi.fn(),
        postponeTask: vi.fn(),
        setTaskProject: vi.fn(),
        setTaskSection: vi.fn(),
        setTaskParent: vi.fn(async () => {}),
        labels: [],
        resolveLabelIds: vi.fn(async () => []),
        projects: [],
        addProject: vi.fn(),
        renameProject: vi.fn(),
        setProjectColour: vi.fn(),
        setProjectDescription: vi.fn(),
        setProjectFavourite: vi.fn(),
        archiveProject: vi.fn(),
        unarchiveProject: vi.fn(),
        setProjectParent: vi.fn(async () => {}),
        reorderProject: vi.fn(),
        listSections: vi.fn(async () => []),
        addSection: vi.fn(async () => {}),
        renameSection: vi.fn(),
        setSectionDescription: vi.fn(),
        reorderSection: vi.fn(),
        deleteSection: vi.fn(),
        archiveSection: vi.fn(),
        unarchiveSection: vi.fn(),
        disabled: false,
        ...overrides,
      };
      return {
        context,
        ...render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <Routes>
                <Route element={<Outlet context={context} />}>
                  <Route
                    path="/"
                    element={
                      <EntryBubble
                        entry={target}
                        syncEnabled={false}
                        side="out"
                        // A defined handler is what `entryBodyContent`
                        // reads as "ticking is permitted here" — the exact
                        // gate `TaskReferenceItem`'s own `interactive` prop
                        // is built from (entry-row.tsx). Its own body is
                        // irrelevant to every test below: a REFERENCED
                        // line never calls it (toggleTaskAt's own splice
                        // retires there — a bare checkbox, not exercised
                        // in this describe block, is what would).
                        onToggleTask={() => {}}
                      />
                    }
                  />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        ),
      };
    }

    it("ticks a non-recurring Task through completeTask, not a body splice", () => {
      const completeTask = vi.fn();
      renderEntryBubble(entry({ body: `- [ ] ${formatTaskReference(taskId, "buy milk")}` }), {
        tasks: [taskFixture()],
        completeTask,
      });

      fireEvent.click(screen.getByRole("checkbox"));

      expect(completeTask).toHaveBeenCalledWith(taskId);
    });

    it("un-ticks a completed non-recurring Task through uncompleteTask", () => {
      const uncompleteTask = vi.fn();
      renderEntryBubble(entry({ body: `- [x] ${formatTaskReference(taskId, "buy milk")}` }), {
        completedTasks: [taskFixture({ completedAt: "2026-08-28T00:00:00.000Z" })],
        uncompleteTask,
      });

      fireEvent.click(screen.getByRole("checkbox"));

      expect(uncompleteTask).toHaveBeenCalledWith(taskId);
    });

    it("stays disabled while the Task hasn't resolved — leads nowhere, per ADR 0042/0048", () => {
      renderEntryBubble(entry({ body: `- [ ] ${formatTaskReference(taskId, "buy milk")}` }), {
        tasks: [],
        completedTasks: [],
      });

      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toBeDisabled();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    // ADR 0048's asymmetric-deletion rule: "Deleting a Task leaves the
    // Entry's line exactly where it was, as the plain text of its last
    // cached label." `removeTask` (use-tasks.ts) tombstones the Task row
    // and touches no Entry at all — a deleted Task is simply absent from
    // both `tasks` and `completedTasks` (TaskStore.list()/listCompleted()
    // both exclude a tombstone by contract), which is exactly the
    // "unresolvable" state this component already renders identically to
    // "not yet Synced": the cached label stays visible, the checkbox goes
    // inert, and nothing about the Entry's own body is rewritten or
    // removed on the reader's behalf.
    it("renders the last cached label, inert, once its Task is deleted — never removes the line", () => {
      const body = `- [ ] ${formatTaskReference(taskId, "buy milk")}`;
      const { unmount } = renderEntryBubble(entry({ body }), { tasks: [taskFixture()] });
      expect(screen.getByText("buy milk")).toBeInTheDocument();
      expect(screen.getByRole("checkbox")).not.toBeDisabled();
      unmount();

      // The Task is gone: `list()`/`listCompleted()` no longer return it,
      // exactly what a tombstone looks like from this component's own
      // vantage point — it has no way to tell "deleted" apart from "never
      // Synced," by ADR 0048's own design. The words the reader captured
      // are still on screen either way; only the interactivity changes.
      renderEntryBubble(entry({ body }), { tasks: [], completedTasks: [] });
      expect(screen.getByText("buy milk")).toBeInTheDocument();
      expect(screen.getByRole("checkbox")).toBeDisabled();
    });

    // ADR 0048/CONTEXT.md's Occurrence entry: a recurring Task's own
    // `completedAt` never becomes non-null, so ticking THIS line has to
    // read as a record of THIS occurrence, pinned to this one Entry, not a
    // write that would also flip every other Entry referencing the same
    // recurring Task.
    describe("a recurring Task", () => {
      it("advances the Task and pins only this Entry's own marker, never completeTask", () => {
        const completeTask = vi.fn();
        const advanceRecurringTask = vi.fn();
        const editEntry = vi.fn();
        const body = `- [ ] ${formatTaskReference(taskId, "water the plants")}`;
        renderEntryBubble(entry({ id: "e9", body }), {
          tasks: [taskFixture({ content: "water the plants", dateString: "every day" })],
          completeTask,
          advanceRecurringTask,
          editEntry,
        });

        fireEvent.click(screen.getByRole("checkbox"));

        expect(completeTask).not.toHaveBeenCalled();
        expect(advanceRecurringTask).toHaveBeenCalledWith(taskId);
        expect(editEntry).toHaveBeenCalledTimes(1);
        const [editedId, editedBody] = editEntry.mock.calls[0] ?? [];
        expect(editedId).toBe("e9");
        expect(editedBody).toContain("[x]");
        expect(editedBody).not.toContain("[ ]");
      });

      it("cannot be reopened — a second click on an already-pinned occurrence does nothing", () => {
        const advanceRecurringTask = vi.fn();
        const editEntry = vi.fn();
        const body = `- [x] ${formatTaskReference(taskId, "water the plants")}`;
        renderEntryBubble(entry({ body }), {
          tasks: [taskFixture({ content: "water the plants", dateString: "every day" })],
          advanceRecurringTask,
          editEntry,
        });

        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).toBeChecked();
        expect(checkbox).toBeDisabled();
        fireEvent.click(checkbox);

        expect(advanceRecurringTask).not.toHaveBeenCalled();
        expect(editEntry).not.toHaveBeenCalled();
      });
    });
  });
});
