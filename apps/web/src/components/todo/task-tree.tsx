/**
 * One sibling group — a Project or Inbox's own top-level Tasks, one
 * Section's own top-level Tasks, or a single Task's own direct sub-tasks
 * — rendered with drag-to-reorder, keyboard reorder and keyboard
 * reparent, and recursing into each row's own children (issue #171).
 *
 * This is the "reuse the list Inbox already uses" component the ticket's
 * own brief asks for: `task-list.tsx` renders one `TaskTree` per bucket
 * (unsectioned, then each Section) for a Project's own view, and Inbox
 * (`todo-page.tsx`) renders exactly one, for its own top-level Tasks —
 * neither is a second implementation of drag/keyboard reorder, both are
 * this same component with a different `tasks` array.
 *
 * The drag/keyboard mechanics here are `todo-page.tsx`'s own pre-#171
 * Inbox implementation, generalised from "the one global Task list" to
 * "whichever sibling group this instance owns" — `measureRows` below is
 * the one piece that had to change to make that safe: `:scope > li` scopes
 * a `querySelectorAll` to this `<ul>`'s own **direct** `<li>` children,
 * which is what keeps a nested `TaskTree` rendering a row's own sub-tasks
 * (a `<ul>` inside that row's own `<li>`) from being swept into *this*
 * level's own measurement — without it, `:scope`-less
 * `container.querySelectorAll("[data-task-id]")` (the pre-#171 version)
 * would also match every descendant several levels down, and a drag two
 * levels up could compute a position against rows that were never its own
 * siblings at all.
 *
 * **Drag-to-reparent nests by dropping in a row's own middle band.** The
 * pointer recogniser (`lib/task-drag-recognizer.ts`) now answers three
 * questions instead of two — "insert before this row," "insert after
 * everything," or "nest under this row" — the third read off a band
 * `dropIndexForPointer`'s own doc comment sizes deliberately, and reached
 * through the identical `setTaskParent` call and `describeReparentError`
 * toast the keyboard path below already uses, per this ticket's own brief:
 * drag must behave identically, not invent a second story. Reparenting by
 * **keyboard** (`Alt`+`ArrowRight`/`ArrowLeft`, this file's own
 * `handleIndent`/`handleOutdent`) is the other path, and
 * `sectionOptions`/`onMoveToSection` on `TaskRow` covers the one
 * drag-shaped gesture neither reaches (moving between Sections, a
 * different sibling group's own top-level list rather than a nesting
 * relationship) — see this ticket's own report for the full accounting.
 */
import { MAX_TASK_NESTING_DEPTH, type Task } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import type { PointerEvent } from "react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { type TaskDetailActions, TaskRow } from "@/components/todo/task-row";
import { taskChildrenQueryKey } from "@/lib/query-keys";
import { refocusTaskHandle } from "@/lib/refocus-task-handle";
import { dropIndexForPointer } from "@/lib/task-drag-recognizer";
import { reorderedTaskOrderKey, siblingMoveDropIndex } from "@/lib/task-reorder";

export interface TaskTreeProps {
  /** This sibling group, in (orderKey, id) order — TaskStore.listByProject/listChildren's own guarantee, whichever one supplied it. */
  tasks: Task[];
  /**
   * The Task that owns this group, or `undefined` for a Project/Inbox/
   * Section's own top-level group. Read only for `handleOutdent` below —
   * outdenting needs to know *this* group's own parent's parent, which is
   * `parentTask.parentId`, not anything derivable from `tasks` itself.
   */
  parentTask?: Task;
  /** 1 for a top-level group, incremented by one at every recursive call — TaskRow's own `depth` prop, for indentation. */
  depth: number;
  /** The Project every Task in this whole tree belongs to, or `null` for Inbox — `handleOutdent`'s own fallback target when a row's parent is already top-level. */
  projectId: string | null;
  /** Passed straight through to every row's own `TaskRow` — see that component's own doc comment on `sectionOptions`. */
  sectionOptions?: { id: string; name: string }[];
  /** Passed straight through, unbound, to every row's own `TaskRow` — see `TaskDetailActions`'s own doc comment (task-row.tsx) for why this needs no per-row binding here the way `onComplete`/etc. below do. */
  detailActions: TaskDetailActions;
  onComplete: (task: Task) => void;
  onCompleteForever: (task: Task) => void;
  onRequestDelete: (task: Task) => void;
  onOpenSchedule: (task: Task) => void;
  onMoveToSection?: (taskId: string, sectionId: string | null) => void;
  reorderTask: (id: string, orderKey: string) => void;
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  listTasksInProject: (projectId: string | null) => Promise<Task[]>;
}

/** Every message TaskStore.setParent's own doc comment names, in the reader-facing words a toast can show — swallowing the exception is exactly what this ticket's own brief refuses (see this file's own header comment). */
function describeReparentError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("nest at most")) {
    return "Sub-tasks only nest four levels deep — this Task is already as deep as it can go.";
  }
  if (message.includes("cycle") || message.includes("already an ancestor")) {
    return "A Task can't become a sub-task of its own sub-task.";
  }
  return "Couldn't move this Task there.";
}

export function TaskTree({
  tasks,
  parentTask,
  depth,
  projectId,
  sectionOptions,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onMoveToSection,
  reorderTask,
  setTaskParent,
  listTaskChildren,
  listTasksInProject,
}: TaskTreeProps) {
  // Drag state, scoped to this one sibling group — see this file's own
  // header comment on why that scoping (not a page-wide singleton) is
  // what makes a nested TaskTree safe. Mirrors todo-page.tsx's pre-#171
  // Inbox implementation field for field; the doc comments there carry
  // the fuller reasoning for each, not repeated here.
  const [drag, setDrag] = useState<{ taskId: string; pointerId: number } | null>(null);
  // Two shapes, not one `string | "end" | null` widened with a `"nest"`
  // case bolted on: `TaskRow` draws two genuinely different indicators
  // (`isDropTarget`'s top-border line vs `isNestTarget`'s row highlight,
  // both below) precisely because a reader mid-drag has to be able to
  // tell "lands between rows" from "lands inside this row" at a glance —
  // this ticket's own brief names conflating them as a real risk, worse
  // than not offering nesting at all. Collapsing both into one string
  // union would leave every reader of this state guessing which kind of
  // target a bare id names; the `kind` tag is what a `switch` (or the
  // `.kind ===` checks below) can exhaust instead of guessing at.
  const [overTarget, setOverTarget] = useState<
    { kind: "before"; id: string } | { kind: "end" } | { kind: "nest"; id: string } | null
  >(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Whether nesting under *any* row in this sibling group is even legal —
  // decided once per level, from the one number already in scope, rather
  // than `dropIndexForPointer` reaching for a store it has no handle to
  // (that function's own `canNest` doc comment). `depth` here is this
  // whole group's own shared depth (every Task in `tasks` sits at it —
  // this component's own `depth` prop doc comment), and it is also
  // exactly the `parentDepth` `assertValidNestingDepth`
  // (`@meologue/core`) judges a would-be parent by: nesting a Task one
  // level under a row at `depth` would place it at `depth + 1`, so the
  // one comparison below is the client-side mirror of the store's own
  // check, computed without an async round trip because — unlike a
  // cycle, which this level's own siblings can never form with each other
  // (two Tasks sharing a parent are never one another's ancestor) — depth
  // is a property of *this level*, not of which two Tasks are involved.
  const canNest = depth < MAX_TASK_NESTING_DEPTH;

  function measureRows(excludeId: string): { ids: string[]; rects: DOMRect[] } {
    const container = listRef.current;
    if (!container) return { ids: [], rects: [] };
    // `:scope > li` — this level's own direct rows only, never a
    // descendant several `TaskTree`s down (this file's own header
    // comment explains why that distinction matters here specifically).
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > li[data-task-id]"),
    ).filter((element) => element.dataset.taskId !== excludeId);
    return {
      ids: rows.map((element) => element.dataset.taskId ?? ""),
      rects: rows.map((element) => element.getBoundingClientRect()),
    };
  }

  function handlePointerDown(taskId: string) {
    return (event: PointerEvent<HTMLButtonElement>) => {
      if (drag !== null) return;
      // See todo-page.tsx's identical pre-#171 comment on this exact
      // `preventDefault` for why it exists (WKWebView text-selection).
      event.preventDefault();
      setDrag({ taskId, pointerId: event.pointerId });
      setOverTarget(null);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // jsdom implements no pointer capture at all — nothing to recover.
      }
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const originalIndex = tasks.findIndex((task) => task.id === drag.taskId);
    const { ids, rects } = measureRows(drag.taskId);
    const verdict = dropIndexForPointer(rects, event.clientY, originalIndex, canNest);
    if (verdict.kind === "moved") {
      const targetId = ids[verdict.dropIndex];
      setOverTarget(targetId !== undefined ? { kind: "before", id: targetId } : { kind: "end" });
    } else if (verdict.kind === "nest") {
      // `ids[verdict.index]` cannot actually be `undefined` — `verdict`
      // was computed against these same `rects`, measured from this same
      // `ids` array, in the line above — but the check costs nothing and
      // keeps this from ever drawing a nest indicator on a target this
      // render pass can't name.
      const targetId = ids[verdict.index];
      setOverTarget(targetId !== undefined ? { kind: "nest", id: targetId } : null);
    } else {
      setOverTarget(null);
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLButtonElement>) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const { taskId, pointerId } = drag;
    try {
      event.currentTarget.releasePointerCapture(pointerId);
    } catch {
      // Already released, or capture never succeeded.
    }
    const originalIndex = tasks.findIndex((task) => task.id === taskId);
    const { ids, rects } = measureRows(taskId);
    const verdict = dropIndexForPointer(rects, event.clientY, originalIndex, canNest);
    if (verdict.kind === "moved") {
      reorderTask(taskId, reorderedTaskOrderKey(tasks, taskId, verdict.dropIndex));
    } else if (verdict.kind === "nest") {
      const targetId = ids[verdict.index];
      if (targetId !== undefined) {
        void handleNestDrop(taskId, targetId);
      }
    }
    setDrag(null);
    setOverTarget(null);
  }

  function handlePointerCancel(event: PointerEvent<HTMLButtonElement>) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released, or capture never succeeded.
    }
    setDrag(null);
    setOverTarget(null);
  }

  function handleMove(taskId: string, index: number, direction: "up" | "down") {
    const dropIndex = siblingMoveDropIndex(index, tasks.length, direction);
    if (dropIndex === null) return;
    reorderTask(taskId, reorderedTaskOrderKey(tasks, taskId, dropIndex));
  }

  // The drag path onto `setTaskParent`, reached from `handlePointerUp`
  // above when the release lands in a row's own nest band
  // (`dropIndexForPointer`'s `"nest"` verdict) — deliberately the same
  // shape as `handleIndent` immediately below it (append as the target's
  // own last child, identical `setTaskParent`/`describeReparentError`
  // error handling), because this ticket's own brief refuses a second
  // reparent story: the only thing that differs from keyboard indent is
  // *which* row is the target — a specific one the pointer named, rather
  // than always "the preceding sibling." A cycle is not checked for here
  // (unlike `describeReparentError`'s own message for one, which this
  // still surfaces if the store somehow throws it) because it cannot
  // occur through this call site at all: `targetId` always names another
  // row from this same `tasks` array, and two Tasks sharing a parent can
  // never be one another's ancestor — dropping `task` onto its own
  // sibling is always a legal, acyclic move. `canNest` (this component's
  // own field) is what already refuses the *depth* failure before the
  // pointer even offers this row as a target, per `dropIndexForPointer`'s
  // own `canNest` doc comment — the `describeReparentError` catch below
  // is defence in depth against a store answer this level's own
  // `depth` happened to disagree with, not the expected path.
  //
  // **This still costs ADR 0050 nothing.** Two calls happen here —
  // `setTaskParent` then `reorderTask` — where a plain reorder makes one,
  // but both land on `taskId`'s own row and no other: `setTaskParent`
  // changes that row's `parentId` (and clears its `seq`, the same
  // "pending again" signal every setter in TaskStore's own doc comments
  // uses), then `reorderTask` changes that *same* row's `orderKey` once
  // its new siblings are known. ADR 0050's own claim is "no sibling's row
  // is touched, because no sibling's position is expressed relative to
  // any other row's" — a claim about which *rows* a reorder may write,
  // not about how many *calls* one gesture makes on the one row it does.
  // A reparenting drop still touches only the dragged Task's own row, in
  // full — it is just two of that row's own columns instead of one, not
  // a second row's write ADR 0050 would have grounds to object to. (The
  // two calls are not atomic with each other — nothing in this stack
  // gives them a transaction, the same absence ADR 0050's own "no
  // transactions" premise names — so a crash between them can leave a
  // Task correctly reparented but still carrying its old `orderKey`
  // among new siblings it no longer has a position among. That Task
  // still renders — sorted arbitrarily relative to its new siblings until
  // the next `reorderTask` moves it deliberately — rather than vanishing
  // or duplicating, which is the same "degrades to a merely untidy state,
  // never a corrupt one" property ADR 0050 already relies on for a lost
  // write mid-reorder.)
  async function handleNestDrop(taskId: string, targetId: string) {
    try {
      await setTaskParent(taskId, targetId);
    } catch (error) {
      toast.error(describeReparentError(error));
      return;
    }
    const freshChildren = await listTaskChildren(targetId);
    reorderTask(taskId, reorderedTaskOrderKey(freshChildren, taskId, freshChildren.length));
  }

  // Reparents `task` under its own preceding sibling, appended as that
  // sibling's own last child — this file's own header comment on why
  // "append at the end" rather than a precisely-placed position, and
  // TaskRowProps' own `onIndent` doc comment on why `Alt`+`ArrowRight`
  // reaches this rather than `Tab`. `index === 0` (no preceding sibling)
  // is a silent no-op, the identical "not every gesture always does
  // something" contract `onMoveUp`'s own doc comment states for the
  // boundary case there.
  async function handleIndent(task: Task, index: number) {
    const target = tasks[index - 1];
    if (target === undefined) return;
    try {
      await setTaskParent(task.id, target.id);
    } catch (error) {
      toast.error(describeReparentError(error));
      return;
    }
    const freshChildren = await listTaskChildren(target.id);
    reorderTask(task.id, reorderedTaskOrderKey(freshChildren, task.id, freshChildren.length));
    // Reparenting remounts this row inside a different `<ul>`, so the
    // handle the reader is holding stops existing and focus falls to
    // `<body>` — see refocus-task-handle.ts for what that cost on the
    // built app (keyboard reparenting worked exactly once). Not done for
    // `onMoveUp`/`onMoveDown`: those keep the same DOM node and focus
    // rides along on its own, confirmed on the built app.
    refocusTaskHandle(task.id);
  }

  // The inverse of handleIndent — reparents `task` to its own
  // grandparent's level, appended at the end of that level. A no-op when
  // this group has no `parentTask` at all (already top-level; there is no
  // level above to outdent into).
  async function handleOutdent(task: Task) {
    if (parentTask === undefined) return;
    const grandParentId = parentTask.parentId;
    try {
      await setTaskParent(task.id, grandParentId);
    } catch (error) {
      toast.error(describeReparentError(error));
      return;
    }
    const freshSiblings =
      grandParentId === null
        ? await listTasksInProject(projectId)
        : await listTaskChildren(grandParentId);
    reorderTask(task.id, reorderedTaskOrderKey(freshSiblings, task.id, freshSiblings.length));
    // Same remount, same focus loss — see handleIndent just above.
    refocusTaskHandle(task.id);
  }

  if (tasks.length === 0) {
    return null;
  }

  return (
    <ul ref={listRef} className="flex flex-col">
      {tasks.map((task, index) => (
        <TaskTreeRow
          key={task.id}
          task={task}
          depth={depth}
          projectId={projectId}
          sectionOptions={sectionOptions}
          detailActions={detailActions}
          isDropTarget={drag !== null && overTarget?.kind === "before" && overTarget.id === task.id}
          isNestTarget={drag !== null && overTarget?.kind === "nest" && overTarget.id === task.id}
          // The raw, task-taking callbacks — not bound to this row here —
          // so this row's own nested TaskTree (its sub-tasks, if any) can
          // forward them unchanged one level deeper, rather than every
          // level rebuilding a fresh closure over the *wrong* Task.
          // TaskTreeRow itself binds each to `task` only for its own
          // TaskRow, immediately below.
          onComplete={onComplete}
          onCompleteForever={onCompleteForever}
          onRequestDelete={onRequestDelete}
          onOpenSchedule={onOpenSchedule}
          onMoveToSection={onMoveToSection}
          onHandlePointerDown={handlePointerDown(task.id)}
          onHandlePointerMove={handlePointerMove}
          onHandlePointerUp={handlePointerUp}
          onHandlePointerCancel={handlePointerCancel}
          onMoveUp={() => handleMove(task.id, index, "up")}
          onMoveDown={() => handleMove(task.id, index, "down")}
          onIndent={() => handleIndent(task, index)}
          onOutdent={() => handleOutdent(task)}
          reorderTask={reorderTask}
          setTaskParent={setTaskParent}
          listTaskChildren={listTaskChildren}
          listTasksInProject={listTasksInProject}
        />
      ))}
      {/* The trailing drop zone — dropping past the last row in this
          sibling group appends rather than being refused for having no
          row to land before. Mirrors todo-page.tsx's own pre-#171 Inbox
          version exactly. */}
      <li
        aria-hidden="true"
        className={`h-3 border-t-2 ${
          drag !== null && overTarget?.kind === "end" ? "border-t-primary" : "border-t-transparent"
        }`}
      />
    </ul>
  );
}

interface TaskTreeRowProps {
  task: Task;
  depth: number;
  projectId: string | null;
  sectionOptions?: { id: string; name: string }[];
  detailActions: TaskDetailActions;
  isDropTarget: boolean;
  isNestTarget: boolean;
  // The raw, task-taking callbacks — see this component's own call site in
  // TaskTree above for why these arrive unbound: this row binds each to
  // `task` for its own TaskRow, then forwards the very same function,
  // untouched, to whatever TaskTree renders this Task's own sub-tasks.
  onComplete: (task: Task) => void;
  onCompleteForever: (task: Task) => void;
  onRequestDelete: (task: Task) => void;
  onOpenSchedule: (task: Task) => void;
  onMoveToSection?: (taskId: string, sectionId: string | null) => void;
  onHandlePointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  reorderTask: (id: string, orderKey: string) => void;
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  listTasksInProject: (projectId: string | null) => Promise<Task[]>;
}

/**
 * One row plus its own recursive `TaskTree` of sub-tasks — split out from
 * `TaskTree` above only because fetching this one Task's own children
 * (`useQuery`, below) has to happen once per row, and React's rules of
 * Hooks refuse a `useQuery` called from inside `tasks.map(...)` directly.
 * Not exported: nothing outside this file has a reason to render one row
 * without the sibling group's own drag/keyboard machinery around it.
 */
function TaskTreeRow({
  task,
  depth,
  projectId,
  sectionOptions,
  detailActions,
  isDropTarget,
  isNestTarget,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onMoveToSection,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandlePointerCancel,
  onMoveUp,
  onMoveDown,
  onIndent,
  onOutdent,
  reorderTask,
  setTaskParent,
  listTaskChildren,
  listTasksInProject,
}: TaskTreeRowProps) {
  // Sub-tasks keep their own order regardless of any sorting or grouping
  // applied to the list above them (issue #171's own acceptance
  // criterion) — this query is keyed by `task.id` alone, entirely
  // untouched by whatever Section bucket or drag state the *parent*
  // level above is in the middle of.
  const childrenQuery = useQuery({
    queryKey: taskChildrenQueryKey(task.id),
    queryFn: () => listTaskChildren(task.id),
  });
  const children = childrenQuery.data ?? [];

  return (
    <>
      <TaskRow
        task={task}
        detailActions={detailActions}
        commentCount={detailActions.commentCountFor(task.id)}
        depth={depth}
        isDropTarget={isDropTarget}
        isNestTarget={isNestTarget}
        onComplete={() => onComplete(task)}
        onCompleteForever={() => onCompleteForever(task)}
        onRequestDelete={() => onRequestDelete(task)}
        onOpenSchedule={() => onOpenSchedule(task)}
        sectionOptions={sectionOptions}
        onMoveToSection={onMoveToSection && ((sectionId) => onMoveToSection(task.id, sectionId))}
        onHandlePointerDown={onHandlePointerDown}
        onHandlePointerMove={onHandlePointerMove}
        onHandlePointerUp={onHandlePointerUp}
        onHandlePointerCancel={onHandlePointerCancel}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onIndent={onIndent}
        onOutdent={onOutdent}
      />
      {children.length > 0 && (
        <TaskTree
          tasks={children}
          parentTask={task}
          depth={depth + 1}
          projectId={projectId}
          detailActions={detailActions}
          onComplete={onComplete}
          onCompleteForever={onCompleteForever}
          onRequestDelete={onRequestDelete}
          onOpenSchedule={onOpenSchedule}
          onMoveToSection={onMoveToSection}
          reorderTask={reorderTask}
          setTaskParent={setTaskParent}
          listTaskChildren={listTaskChildren}
          listTasksInProject={listTasksInProject}
        />
      )}
    </>
  );
}
