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

  // Issue #153, retired by issue #231 (ADR 0074): a bare checkbox used to
  // become a live, tickable control once `onToggleTask` was supplied, and
  // clicking it called back with the Entry and the marker's own source
  // offsets so the caller could splice the body. It is now permanently
  // disabled no matter what — a bare checkbox has no Task to open (this
  // file's own doc comment on `EntryBubbleProps.onToggleTask`,
  // entry-prose.tsx's module comment) — so `onToggleTask` being supplied
  // or not no longer changes anything about how a bare checkbox renders.
  describe("onToggleTask", () => {
    it("renders the checkbox disabled with no handler wired", () => {
      render(
        <EntryBubble entry={entry({ body: "- [ ] call mum" })} syncEnabled={false} side="out" />,
      );

      expect(screen.getByRole("checkbox")).toBeDisabled();
    });

    it("stays disabled, and never calls the handler, even once one is supplied", () => {
      const onToggleTask = vi.fn();
      const body = "- [ ] call mum";
      const withTask = entry({ body });
      render(
        <EntryBubble entry={withTask} syncEnabled={false} side="out" onToggleTask={onToggleTask} />,
      );

      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toBeDisabled();
      fireEvent.click(checkbox);

      expect(onToggleTask).not.toHaveBeenCalled();
    });
  });

  // Issue #173 — `TaskReferenceItem` (entry-row.tsx), rendered here through
  // History's own thread (`EntryBubble`). Needs `useEntryStore()`, unlike
  // every other test above in this file, so this describe block alone
  // stands the component up inside the router/query wiring
  // `entry-row.test.tsx`'s own `renderEntryRow` already established for
  // the identical reason. Since issue #231 (ADR 0074), a click here opens
  // the Task (`onOpenTask`) rather than writing it — see each test's own
  // comment for the write calls it now proves never happen.
  describe("a task reference", () => {
    const taskId = "0192abcd-1234-7890-abcd-0123456789ac";

    function taskFixture(overrides: Partial<Task> = {}): Task {
      return {
        id: taskId,
        deviceId: "device-a",
        content: "buy milk",
        completedAt: null,
        orderKey: "V",
        dayOrder: "V",
        // Issue #196: updatedAt starts equal to createdAt
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
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
        description: null,
        ...overrides,
      };
    }

    function renderEntryBubble(
      target: Entry,
      overrides: Partial<EntryStoreOutletContext> = {},
      // Issue #231 (ADR 0074): every test below now clicks the checkbox
      // expecting it to open the Task, not tick it — `onOpenTask` needs to
      // be a real, assertable spy in most of them, so it's threaded
      // through here rather than hardcoded the way `onToggleTask` still
      // is a few lines down (that one is never called any more, so which
      // function it is doesn't matter to anything below).
      onOpenTask: (taskId: string) => void = vi.fn(),
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
        reorderTaskToday: vi.fn(),
        removeTask: vi.fn(),
        setTaskDate: vi.fn(),
        setTaskDeadline: vi.fn(),
        setTaskPriority: vi.fn(),
        setTaskDateString: vi.fn(),
        setTaskLabels: vi.fn(),
        setTaskDescription: vi.fn(),
        listTasksInProject: vi.fn(async () => []),
        listTaskChildren: vi.fn(async () => []),
        countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
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
        resolveProjectId: vi.fn(async () => ""),
        resolveSectionId: vi.fn(async () => ""),
        comments: [],
        addComment: vi.fn(),
        editComment: vi.fn(),
        removeComment: vi.fn(),
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
        events: [],
        listEventsByTask: vi.fn(async () => []),
        listEventsByProject: vi.fn(async () => []),
        filters: [],
        addFilter: vi.fn(() => "filter-1"),
        renameFilter: vi.fn(),
        setFilterColour: vi.fn(),
        setFilterQuery: vi.fn(async () => {}),
        removeFilter: vi.fn(),
        addLabel: vi.fn(),
        renameLabel: vi.fn(),
        setLabelColour: vi.fn(),
        removeLabel: vi.fn(),
        removeProject: vi.fn(),
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
                        // Never called any more (issue #231, ADR 0074) —
                        // a REFERENCED line's checkbox below opens the
                        // Task through `onOpenTask` instead, exactly like
                        // its words already do, and a bare checkbox, not
                        // exercised in this describe block, is
                        // permanently disabled regardless of this prop
                        // (entry-prose.tsx's own module comment). Kept
                        // non-`undefined` only because that's what
                        // `entryBodyContent`'s own `interactive` argument
                        // still reads off it (entry-bubble.tsx's own doc
                        // comment on `EntryBubbleProps.onToggleTask`) —
                        // `interactive` itself no longer gates anything a
                        // referenced line's checkbox does either
                        // (entry-row.tsx's own `TaskReferenceItem`
                        // comment), so this is inert two layers deep, not
                        // one.
                        onToggleTask={() => {}}
                        onOpenTask={onOpenTask}
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

    // Issue #231 (ADR 0074): a referenced checkbox's click used to write
    // the Task directly (issue #173, ADR 0048's "ticking writes the
    // Task") — `completeTask`/`uncompleteTask` below. Todo is now the
    // only place completion happens; History's own checkbox opens the
    // Task instead, exactly like its words already do (`onOpenTask`,
    // issue #181), and touches neither the Task nor this Entry's body.
    it("opens a non-recurring Task instead of ticking it, and never calls completeTask/uncompleteTask", () => {
      const completeTask = vi.fn();
      const uncompleteTask = vi.fn();
      const onOpenTask = vi.fn();
      renderEntryBubble(
        entry({ body: `- [ ] ${formatTaskReference(taskId, "buy milk")}` }),
        { tasks: [taskFixture()], completeTask, uncompleteTask },
        onOpenTask,
      );

      fireEvent.click(screen.getByRole("checkbox"));

      expect(onOpenTask).toHaveBeenCalledWith(taskId);
      expect(completeTask).not.toHaveBeenCalled();
      expect(uncompleteTask).not.toHaveBeenCalled();
    });

    it("opens an already-completed Task the same way, and never calls uncompleteTask", () => {
      const uncompleteTask = vi.fn();
      const onOpenTask = vi.fn();
      renderEntryBubble(
        entry({ body: `- [x] ${formatTaskReference(taskId, "buy milk")}` }),
        {
          completedTasks: [taskFixture({ completedAt: "2026-08-28T00:00:00.000Z" })],
          uncompleteTask,
        },
        onOpenTask,
      );

      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);

      expect(onOpenTask).toHaveBeenCalledWith(taskId);
      expect(uncompleteTask).not.toHaveBeenCalled();
    });

    it("stays disabled while the Task hasn't resolved, and calls nothing — leads nowhere, per ADR 0042/0048", () => {
      const onOpenTask = vi.fn();
      renderEntryBubble(
        entry({ body: `- [ ] ${formatTaskReference(taskId, "buy milk")}` }),
        { tasks: [], completedTasks: [] },
        onOpenTask,
      );

      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toBeDisabled();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
      expect(onOpenTask).not.toHaveBeenCalled();
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
    // `completedAt` never becomes non-null, and — since issue #231, ADR
    // 0074 — this component never advances one from a click any more
    // either (`advanceRecurringTask`, use-tasks.ts, now fires only from
    // Todo/the Composer's own Task overlay, composer-page.tsx's
    // `handleCompleteTask`). A recurring reference's checkbox opens the
    // Task exactly like a non-recurring one does, whether or not this
    // occurrence already reads checked — there is no "cannot be
    // reopened" refusal left to make here, because opening was never the
    // thing that rule was about.
    describe("a recurring Task", () => {
      it("opens the Task instead of advancing it, and never calls editEntry", () => {
        const advanceRecurringTask = vi.fn();
        const editEntry = vi.fn();
        const onOpenTask = vi.fn();
        const body = `- [ ] ${formatTaskReference(taskId, "water the plants")}`;
        renderEntryBubble(
          entry({ id: "e9", body }),
          {
            tasks: [taskFixture({ content: "water the plants", dateString: "every day" })],
            advanceRecurringTask,
            editEntry,
          },
          onOpenTask,
        );

        fireEvent.click(screen.getByRole("checkbox"));

        expect(onOpenTask).toHaveBeenCalledWith(taskId);
        expect(advanceRecurringTask).not.toHaveBeenCalled();
        expect(editEntry).not.toHaveBeenCalled();
      });

      it("still opens the Task once this occurrence already reads checked — nothing left to refuse a second click for", () => {
        const advanceRecurringTask = vi.fn();
        const editEntry = vi.fn();
        const onOpenTask = vi.fn();
        const body = `- [x] ${formatTaskReference(taskId, "water the plants")}`;
        renderEntryBubble(
          entry({ body }),
          {
            tasks: [taskFixture({ content: "water the plants", dateString: "every day" })],
            advanceRecurringTask,
            editEntry,
          },
          onOpenTask,
        );

        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).toBeChecked();
        expect(checkbox).not.toBeDisabled();
        fireEvent.click(checkbox);

        expect(onOpenTask).toHaveBeenCalledWith(taskId);
        expect(advanceRecurringTask).not.toHaveBeenCalled();
        expect(editEntry).not.toHaveBeenCalled();
      });
    });
  });
});
