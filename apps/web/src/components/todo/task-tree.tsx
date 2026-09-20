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
 * **The `<ul>` really is inside that row's own `<li>` — issue #192, not
 * an aspiration this comment used to state ahead of the code.** Before
 * #192, a nested `TaskTree` rendering a row's own sub-tasks emitted that
 * `<ul>` as a *sibling* of the row's own `<li>`, both direct children of
 * this level's own `<ul>` — invalid HTML (a `ul` may hold only `li`), and
 * this paragraph's own claim about where the nested list lives was true
 * of the *intent*, not the markup, until that ticket made it true of the
 * markup too (`task-row.tsx`'s own header comment carries the fix). That
 * changes what `:scope > li[data-task-id]` finds a rect *for*, even
 * though it changes nothing about which `<li>`s it finds: a matched
 * `<li>` can now itself contain an entire rendered subtree beneath its
 * own row, so `measureRows` below reads each row's own
 * `[data-task-row-box]` — task-row.tsx's own inner `<div>` that carries
 * every visual/interaction concern the `<li>` used to — rather than the
 * `<li>`'s own `getBoundingClientRect()`, which would otherwise hand
 * `dropIndexForPointer` a box tall enough to swallow every visible
 * descendant of a row with children open. `:scope > li` itself needed no
 * change for this — it was never wrong about *membership*, only ever
 * silent about *geometry*, and only once #192 gave it something to be
 * silent about.
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
import { useCallback, useEffect, useRef, useState } from "react";
import { CompletedTasksLoadMore } from "@/components/todo/completed-tasks-load-more";
import { type TaskDetailActions, TaskRow } from "@/components/todo/task-row";
import { toast } from "@/components/ui/toast";
import { useCompletedTasksPage } from "@/hooks/use-completed-tasks-page";
import { useSwipeActions } from "@/hooks/use-swipe-actions";
import { taskChildCountsQueryKey, taskChildrenQueryKey } from "@/lib/query-keys";
import { refocusTaskHandle } from "@/lib/refocus-task-handle";
import { dropIndexForPointer } from "@/lib/task-drag-recognizer";
import { reorderedTaskOrderKey, siblingMoveDropIndex } from "@/lib/task-reorder";
import { OPEN_SCHEDULE_EVENT } from "@/lib/todo-keymap";

export interface TaskTreeProps {
  /** This sibling group, in (orderKey, id) order — TaskStore.listByProject/listChildren's own guarantee, whichever one supplied it. */
  tasks: Task[];
  completedTasks?: Task[];
  onUncomplete?: (task: Task) => void;
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
  onMoveToSection?: (taskId: string, sectionId: string | null) => void;
  reorderTask: (id: string, orderKey: string) => void;
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  /** A Task's `done`/`total` sub-task counts (issue #298) — separate from `listTaskChildren` because that list excludes completed sub-tasks and so cannot supply either number once one is finished. */
  countTaskChildren: (parentId: string) => Promise<{ done: number; total: number }>;
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
  completedTasks = [],
  onUncomplete,
  parentTask,
  depth,
  projectId,
  sectionOptions,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onMoveToSection,
  reorderTask,
  setTaskParent,
  listTaskChildren,
  countTaskChildren,
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

  // Issue #308, diagnosed and verified on the device, not from jsdom
  // (which has no compositor and so cannot produce this at all): once
  // armed, the row's own box still carries `touch-pan-y` (issue #303's
  // own class, for swipe-to-schedule — the grip survives this because it
  // separately carries `touch-none`, `task-row-content.tsx`'s own grip
  // markup), so the browser is still entitled to claim the vertical axis
  // for its own panning. Traced on-device event order: `pointerdown` →
  // `contextmenu` → ONE `pointermove` → `pointercancel` →
  // `lostpointercapture` — the compositor takes the axis and kills the
  // pointer stream after the very first real move, before this level's
  // own `handlePointerMove` ever sees enough of them to compute a verdict
  // that reorders anything. `touch-action` is decided at the touch's own
  // start and is immune to changing it mid-gesture, so the fix isn't a
  // class — it's suppressing the browser's own default action on
  // `touchmove` directly, and ONLY for the duration of an armed drag: a
  // permanent listener would take vertical scrolling away from every
  // reader dragging a finger down an un-armed row, a worse regression
  // than the one this fixes.
  //
  // A ref, not state: this holds a listener FUNCTION, compared for
  // identity against nothing a render needs to read, and is written from
  // plain start/stop calls below, never from a render itself.
  const touchMoveBlockerRef = useRef<((event: TouchEvent) => void) | null>(null);

  /**
   * Registered NATIVELY, with `addEventListener`, never through JSX's
   * `onTouchMove` — React's own root listener for that event is
   * `{ passive: true }` (React's own default for every touch/wheel
   * listener, to keep the main thread free to scroll without waiting on
   * a handler), and `preventDefault()` called from inside a passive
   * listener is a silent no-op, not an error: the on-device trace above
   * is what caught that, since nothing about it would ever surface as a
   * thrown exception or a failing assertion. `{ passive: false }` here is
   * what actually gives this listener the standing to cancel the
   * browser's own pan.
   *
   * On `document`, not the row itself: `touchmove` is a legacy `Touch`
   * event, not a `PointerEvent`, and nothing guarantees it follows
   * `setPointerCapture`'s own retargeting the way a genuine pointer event
   * does. `document` sees it regardless of which element the finger is
   * physically over as the drag continues across other rows.
   */
  const blockTouchScroll = useCallback(() => {
    const blocker = (event: TouchEvent) => {
      event.preventDefault();
    };
    touchMoveBlockerRef.current = blocker;
    document.addEventListener("touchmove", blocker, { passive: false });
  }, []);

  /** The inverse of `blockTouchScroll` — every exit from an armed drag (a commit, a cancel, or this component going away mid-drag) has to reach this, or a reader's very next scroll on an unrelated row would silently stop working. */
  const unblockTouchScroll = useCallback(() => {
    const blocker = touchMoveBlockerRef.current;
    if (blocker === null) return;
    document.removeEventListener("touchmove", blocker);
    touchMoveBlockerRef.current = null;
  }, []);

  // The unmount case `handlePointerUp`/`handlePointerCancel` below can't
  // cover themselves: a `TaskTree` going away mid-drag (an Escape-driven
  // route change, a Task deleted out from under an in-flight drag) still
  // has to give scrolling back to the rest of the page. `useCallback`
  // (empty deps, same as `blockTouchScroll` above) is what keeps this
  // effect from re-running every render: both functions only ever touch
  // the ref above, never anything that changes between renders, so a
  // stable identity costs nothing and is what a `[]` dependency array can
  // honestly claim.
  useEffect(() => unblockTouchScroll, [unblockTouchScroll]);

  // Issue #303: swiping a row left opens its own `TaskSchedulePopover` —
  // reusing `use-swipe-actions.ts`'s shared recogniser, the identical one
  // `history.tsx`'s own bubbles use, rather than growing a second one.
  //
  // Attached only at `depth === 1` — this level's own top-level sibling
  // group — even though every nested level below it renders through this
  // same component and calls this same hook. `enabled` (not a conditional
  // hook call, which the rules of Hooks forbid) is what actually decides
  // that: every nested call still installs its own four listeners, all
  // permanently inert. That's safe, not merely harmless, because a nested
  // level's own `<ul>` renders *inside* its own row's `<li>` (issue #192 —
  // this file's own header comment), which means it is already a DOM
  // descendant of the depth-1 `<ul>` below. A pointerdown on a sub-task's
  // own row therefore already bubbles up to the depth-1 container's own
  // listener without this level needing an enabled recogniser of its own —
  // and giving every level one instead would mean two enabled recognisers
  // racing the identical pointer for a nested row (this file's own
  // `swipe-to-schedule` test covers exactly that risk).
  const openScheduleForSwipe = useCallback((target: HTMLElement) => {
    const taskId = target.dataset.taskId;
    if (taskId !== undefined) {
      // The identical fan-in the `T` keyboard shortcut already uses
      // (todo-keymap.ts's own `OPEN_SCHEDULE_EVENT` doc comment) — this
      // tree has no direct reference to the swiped row's own `scheduleOpen`
      // state (owned by `task-row.tsx`, several props away), so a
      // document-level event is the one door onto it that doesn't mean
      // threading a new callback through `TaskDetailActions`.
      document.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId } }));
    }
  }, []);
  const swipeRowsRef = useSwipeActions({
    onOpen: openScheduleForSwipe,
    enabled: depth === 1,
  });

  // Issue #358: how much of `completedTasks` is on screen right now, and
  // the "Load more" door onto the rest — called unconditionally, before
  // this component's own `tasks.length === 0 && completedTasks.length ===
  // 0` early return below, because a hook can never be skipped on some
  // renders and not others (the Rules of Hooks) the way a plain local
  // wouldn't have to be.
  const completedPage = useCompletedTasksPage(completedTasks.length);

  function measureRows(excludeId: string): { ids: string[]; rects: DOMRect[] } {
    const container = listRef.current;
    if (!container) return { ids: [], rects: [] };
    // `:scope > li` — this level's own direct rows only, never a
    // descendant several `TaskTree`s down (this file's own header
    // comment explains why that distinction matters here specifically).
    // Issue #192 nested each row's own sub-task `<ul>` *inside* that row's
    // own `<li>` (task-row.tsx's own header comment), which is what makes
    // this membership check alone insufficient: a matched `<li>` here can
    // now itself contain an entire, already-rendered subtree, several rows
    // tall, beneath its own row. `:scope > li` still names the right set
    // of `<li>`s — this level's own siblings, and only those — but is
    // never asked for a *rect* below; see the `rowBox`/`rects.map` split
    // just below for what actually stands in for each `<li>`'s geometry.
    // No `:not([data-completed-task])` guard needed here any more (issue
    // #358): a completed row now renders in its own trailing `<ul>`,
    // entirely outside `listRef`'s own container (this component's own
    // return statement below), so `:scope > li` can never match one to
    // begin with — unlike before this ticket, when a completed row
    // interleaved inline in this same `<ul>` (rendered through the
    // identical `TaskRow` an active sibling uses, still carrying
    // `data-task-id` for `todo-keymap.ts`'s `focusedTaskId()`) and had to
    // be excluded explicitly. A completed row is still not draggable and
    // is still never a legal drop/nest target (this file's own
    // `completedTasks` doc comment on `TaskTreeProps`); it simply cannot
    // reach this selector at all now, which is a stronger guarantee than
    // filtering it out after the fact.
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > li[data-task-id]"),
    ).filter((element) => element.dataset.taskId !== excludeId);
    return {
      ids: rows.map((element) => element.dataset.taskId ?? ""),
      // Deliberately *not* `element.getBoundingClientRect()` — a matched
      // `<li>`'s own border-box now encloses its rendered sub-tasks too
      // (issue #192), so measuring the `<li>` directly would hand
      // `dropIndexForPointer` a box tall enough to swallow several rows
      // whenever the row it belongs to has any children open beneath it,
      // and a pointer visually over a grandchild row several rows down
      // would misread as still hovering the ancestor's own band. Reading
      // `[data-task-row-box]` instead — task-row.tsx's own inner `<div>`
      // that now carries every visual/interaction concern the `<li>` used
      // to (that file's own header comment) — measures exactly this row's
      // own header strip and nothing beneath it, which is what every
      // caller of `measureRows` (`dropIndexForPointer`, `siblingMoveDropIndex`
      // indirectly through `handleMove`) has always assumed a "row" means.
      // The `?? element` fallback only guards a `TaskRow` that somehow
      // rendered without its own row box — never expected, since `TaskRow`
      // always renders one — rather than something this level has any way
      // to construct a better rect from.
      rects: rows.map((element) => {
        const rowBox = element.querySelector<HTMLElement>(":scope > [data-task-row-box]");
        return (rowBox ?? element).getBoundingClientRect();
      }),
    };
  }

  // Issue #308: the one place both the grip's `pointerdown` and a
  // long-press on the row's own body actually arm the shared `drag`
  // state — extracted so the two entry points can't drift into arming it
  // two different ways. `captureTarget` is deliberately a plain `Element`,
  // not `event.currentTarget` read inside here: the grip hands this its
  // own button, `task-row.tsx`'s long-press timer hands this the `<li>`
  // it fired from (`onLongPressArm`'s own doc comment, TaskRowProps, on
  // why that timer holds no live event by the time it fires at all).
  function armDrag(taskId: string, pointerId: number, captureTarget: Element) {
    if (drag !== null) return;
    setDrag({ taskId, pointerId });
    setOverTarget(null);
    blockTouchScroll();
    try {
      captureTarget.setPointerCapture(pointerId);
    } catch {
      // jsdom implements no pointer capture at all — nothing to recover.
    }
  }

  function handlePointerDown(taskId: string) {
    return (event: PointerEvent<HTMLButtonElement>) => {
      if (drag !== null) return;
      // See todo-page.tsx's identical pre-#171 comment on this exact
      // `preventDefault` for why it exists (WKWebView text-selection).
      event.preventDefault();
      armDrag(taskId, event.pointerId, event.currentTarget);
    };
  }

  // Issue #308's second door onto `armDrag` above — reached from a
  // long-press on the row's own body once `task-row.tsx`'s own timer
  // survives the three-way race against scrolling and swipe-to-schedule,
  // rather than from a `pointerdown` on the grip. No `event` to read
  // `preventDefault` off here (see `onLongPressArm`'s own doc comment,
  // TaskRowProps): a still hold that turns into a lift has nothing native
  // left worth suppressing at the moment this fires — the platform's own
  // long-press → contextmenu translation is what `task-row.tsx`'s own
  // `onContextMenu` guards separately, not this.
  function armLiftFromLongPress(taskId: string) {
    return (pointerId: number, captureTarget: Element) => {
      armDrag(taskId, pointerId, captureTarget);
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
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

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
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
    unblockTouchScroll();
    setDrag(null);
    setOverTarget(null);
  }

  function handlePointerCancel(event: PointerEvent<HTMLElement>) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released, or capture never succeeded.
    }
    unblockTouchScroll();
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

  if (tasks.length === 0 && completedTasks.length === 0) {
    return null;
  }

  const visibleCompletedTasks = completedTasks.slice(0, completedPage.visibleCount);

  return (
    <>
      <ul
        ref={(node) => {
          listRef.current = node;
          swipeRowsRef(node);
        }}
        className="flex flex-col"
      >
        {tasks.map((task, index) => (
          <TaskTreeRow
            key={task.id}
            task={task}
            depth={depth}
            projectId={projectId}
            sectionOptions={sectionOptions}
            detailActions={detailActions}
            isDropTarget={
              drag !== null && overTarget?.kind === "before" && overTarget.id === task.id
            }
            isNestTarget={drag !== null && overTarget?.kind === "nest" && overTarget.id === task.id}
            isDragging={drag !== null && drag.taskId === task.id}
            // The raw, task-taking callbacks — not bound to this row here —
            // so this row's own nested TaskTree (its sub-tasks, if any) can
            // forward them unchanged one level deeper, rather than every
            // level rebuilding a fresh closure over the *wrong* Task.
            // TaskTreeRow itself binds each to `task` only for its own
            // TaskRow, immediately below.
            onComplete={onComplete}
            onCompleteForever={onCompleteForever}
            onRequestDelete={onRequestDelete}
            onMoveToSection={onMoveToSection}
            onHandlePointerDown={handlePointerDown(task.id)}
            onHandlePointerMove={handlePointerMove}
            onHandlePointerUp={handlePointerUp}
            onHandlePointerCancel={handlePointerCancel}
            onLongPressArm={armLiftFromLongPress(task.id)}
            onMoveUp={() => handleMove(task.id, index, "up")}
            onMoveDown={() => handleMove(task.id, index, "down")}
            onIndent={() => handleIndent(task, index)}
            onOutdent={() => handleOutdent(task)}
            reorderTask={reorderTask}
            setTaskParent={setTaskParent}
            listTaskChildren={listTaskChildren}
            countTaskChildren={countTaskChildren}
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
            drag !== null && overTarget?.kind === "end"
              ? "border-t-primary"
              : "border-t-transparent"
          }`}
        />
      </ul>
      {visibleCompletedTasks.length > 0 && (
        <>
          <ul className="flex flex-col">
            {visibleCompletedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                depth={depth}
                sectionOptions={sectionOptions}
                detailActions={detailActions}
                commentCount={detailActions.commentCountFor(task.id)}
                onComplete={() => onComplete(task)}
                onCompleteForever={() => onCompleteForever(task)}
                onUncomplete={() => onUncomplete?.(task)}
                onRequestDelete={() => onRequestDelete(task)}
                onMoveToSection={
                  onMoveToSection && ((sectionId) => onMoveToSection(task.id, sectionId))
                }
                // Issue #310: this whole tree belongs to one Project
                // (`projectId` non-null) or is Inbox (`null`) — the same
                // signal `handleOutdent` already reads `projectId` for
                // elsewhere in this file — so a Project's own view (and
                // every Section bucket `task-list.tsx` renders inside it,
                // all of them this same non-null `projectId`) suppresses
                // the badge that would otherwise repeat the Project this
                // screen is already titled with.
                suppressProjectBadge={projectId !== null}
              />
            ))}
          </ul>
          <CompletedTasksLoadMore
            remaining={completedPage.remaining}
            onLoadMore={completedPage.loadMore}
          />
        </>
      )}
    </>
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
  /** See `TaskTree`'s own `isDragging` call-site comment and `TaskRow`'s identical prop doc (task-row.tsx) — forwarded straight through. */
  isDragging: boolean;
  // The raw, task-taking callbacks — see this component's own call site in
  // TaskTree above for why these arrive unbound: this row binds each to
  // `task` for its own TaskRow, then forwards the very same function,
  // untouched, to whatever TaskTree renders this Task's own sub-tasks.
  onComplete: (task: Task) => void;
  onCompleteForever: (task: Task) => void;
  onRequestDelete: (task: Task) => void;
  onMoveToSection?: (taskId: string, sectionId: string | null) => void;
  onHandlePointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerMove: (event: PointerEvent<HTMLElement>) => void;
  onHandlePointerUp: (event: PointerEvent<HTMLElement>) => void;
  onHandlePointerCancel: (event: PointerEvent<HTMLElement>) => void;
  /** See `TaskRow`'s own identical prop doc comment (task-row.tsx, TaskRowProps). */
  onLongPressArm: (pointerId: number, captureTarget: Element) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  reorderTask: (id: string, orderKey: string) => void;
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  /** A Task's `done`/`total` sub-task counts (issue #298) — separate from `listTaskChildren` because that list excludes completed sub-tasks and so cannot supply either number once one is finished. */
  countTaskChildren: (parentId: string) => Promise<{ done: number; total: number }>;
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
  isDragging,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onMoveToSection,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandlePointerCancel,
  onLongPressArm,
  onMoveUp,
  onMoveDown,
  onIndent,
  onOutdent,
  reorderTask,
  setTaskParent,
  listTaskChildren,
  countTaskChildren,
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
  // Issue #298: the badge's two numbers, asked for separately because
  // `childrenQuery` above excludes completed sub-tasks by definition and so
  // can supply neither of them once any child is finished. One aggregate,
  // under the same TASKS_QUERY_KEY prefix, so a Task write invalidates it
  // alongside the list without bespoke wiring.
  const childCountsQuery = useQuery({
    queryKey: taskChildCountsQueryKey(task.id),
    queryFn: () => countTaskChildren(task.id),
  });
  const childCounts = childCountsQuery.data ?? { done: 0, total: children.length };

  return (
    // No Fragment of `<TaskRow>` then a sibling `<TaskTree>` any more
    // (issue #192) — `TaskRow` itself accepts this row's own sub-tasks as
    // `children` and renders them inside its own `<li>` (that component's
    // own doc comment on `children` explains why the acceptance criterion
    // — "a `<ul>` inside that row's own `<li>`" — has to be met there,
    // not here: this component has no `<li>` of its own to nest anything
    // inside). Passing `undefined` rather than `null`/`false` when there
    // are no children is deliberate only in that it costs nothing extra:
    // `TaskRow`'s own `children?: ReactNode` already treats an absent
    // value as "nothing to render," the same default every other optional
    // prop on that component uses.
    <TaskRow
      task={task}
      detailActions={detailActions}
      commentCount={detailActions.commentCountFor(task.id)}
      // Issue #298: `total`, not `children.length`. The list above is the
      // *active* children — it decides whether to render a nested `TaskTree`
      // at all — and a parent whose sub-tasks are all done has none, so
      // reading the badge off it counted 0 for a Task that was in fact 2/2.
      // Falls back to `children.length` until the count resolves, which is
      // the old number and never larger than the true total.
      subtaskCount={childCounts.total}
      subtaskDone={childCounts.done}
      depth={depth}
      isDropTarget={isDropTarget}
      isNestTarget={isNestTarget}
      isDragging={isDragging}
      onComplete={() => onComplete(task)}
      onCompleteForever={() => onCompleteForever(task)}
      onRequestDelete={() => onRequestDelete(task)}
      sectionOptions={sectionOptions}
      onMoveToSection={onMoveToSection && ((sectionId) => onMoveToSection(task.id, sectionId))}
      onHandlePointerDown={onHandlePointerDown}
      onHandlePointerMove={onHandlePointerMove}
      onHandlePointerUp={onHandlePointerUp}
      onHandlePointerCancel={onHandlePointerCancel}
      onLongPressArm={onLongPressArm}
      onMoveUp={onMoveUp}
      onMoveDown={onMoveDown}
      onIndent={onIndent}
      onOutdent={onOutdent}
      // Issue #310: see the identical check's own comment at this file's
      // other `TaskRow` call site (the completed-row branch, above) —
      // same signal, same reasoning, this row just isn't `completedTasks`.
      suppressProjectBadge={projectId !== null}
    >
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
          onMoveToSection={onMoveToSection}
          reorderTask={reorderTask}
          setTaskParent={setTaskParent}
          listTaskChildren={listTaskChildren}
          countTaskChildren={countTaskChildren}
          listTasksInProject={listTasksInProject}
        />
      )}
    </TaskRow>
  );
}
