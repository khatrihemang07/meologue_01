import type { PointerEvent } from "react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { Shell } from "@/components/shell";
import { AddTaskForm } from "@/components/todo/add-task-form";
import { CompletedTasks } from "@/components/todo/completed-tasks";
import { TaskRow } from "@/components/todo/task-row";
import { TodoNav } from "@/components/todo/todo-nav";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { dropIndexForPointer } from "@/lib/task-drag-recognizer";
import { reorderedTaskOrderKey } from "@/lib/task-reorder";
import { useEntryStore } from "@/pages/entry-store-layout";

/**
 * Inbox — Todo's one view for this ticket (issue #168; ADR 0049 names it as
 * the first of several `/todo/*` routes rather than the whole of Todo).
 * Lists active Tasks in `(orderKey, id)` order (TaskStore.list()'s own
 * guarantee), with the ordinary CRUD-plus-reorder set the ticket's
 * acceptance criteria name: add, complete (with an Undo toast and a
 * durable Completed section — see the comment on `handleComplete` below),
 * uncomplete, delete (behind the shared `ConfirmDialog`, same as
 * `sessions-page.tsx`/`history.tsx`), and drag-to-reorder.
 *
 * Renders through `Shell` the same way every other Destination does,
 * `composerSlot={<TodoNav />}` docking Todo's own internal navigation at
 * the pane's bottom edge — the one row that view offers today is exactly
 * where the reader already is (ADR 0049), and #169's Today will be a
 * second row there, not a restructuring of this page.
 */
export function TodoPage() {
  const {
    tasks,
    completedTasks,
    addTask,
    completeTask,
    uncompleteTask,
    reorderTask,
    removeTask,
    disabled,
    message,
  } = useEntryStore();

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmingTask = tasks.find((task) => task.id === confirmingId) ?? null;

  // Drag state (ADR 0050, and issue #168's own follow-up: native HTML5
  // drag-and-drop never fires on Android — WebView doesn't synthesise
  // `dragstart` from touch input — so a Pointer Events recogniser, the same
  // shape `use-swipe-actions.ts` already uses for an Entry row's swipe,
  // replaces it here rather than living alongside it as a second mechanism
  // that could disagree with the first).
  //
  // `drag` names the Task the pointer picked up and the pointer doing the
  // picking — the pointer id matters because a second finger landing on a
  // different row's handle mid-drag must be ignored rather than stealing
  // the gesture, the same "one drag at a time" rule
  // `task-drag-recognizer.ts`'s own header explains for a second finger.
  // `overTarget` names where a release right now would land — either
  // another Task's id (insert before that row) or `"end"` (the trailing
  // drop zone below the last row, append after everything). Neither
  // persists anything on its own; `commitDrop` below is the one place that
  // turns this state into the single `reorderTask` call ADR 0050 requires.
  const [drag, setDrag] = useState<{ taskId: string; pointerId: number } | null>(null);
  const [overTarget, setOverTarget] = useState<string | "end" | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // The one fact `dropIndexForPointer` actually needs and nothing else:
  // where every OTHER active Task's row currently sits on screen, in DOM
  // order, read straight off the elements rather than assumed from CSS —
  // `history.tsx`'s own comment names the same "jsdom never lays anything
  // out" gap this works around in the test suite via a stubbed
  // `getBoundingClientRect`. `excludeId` is filtered out here rather than
  // by the caller: it is never a valid drop target for itself, and
  // excluding it here is what keeps the returned `ids`/`rects` pair
  // aligned index-for-index with `reorderedTaskOrderKey`'s own
  // `withoutDragged` space.
  function measureRows(excludeId: string): { ids: string[]; rects: DOMRect[] } {
    const container = listRef.current;
    if (!container) return { ids: [], rects: [] };
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]")).filter(
      (element) => element.dataset.taskId !== excludeId,
    );
    return {
      ids: rows.map((element) => element.dataset.taskId ?? ""),
      rects: rows.map((element) => element.getBoundingClientRect()),
    };
  }

  function handleHandlePointerDown(taskId: string) {
    return (event: PointerEvent<HTMLSpanElement>) => {
      if (drag !== null) return;
      // Verified on the macOS/WKWebView build, and invisible everywhere
      // else: without this, pressing on the handle starts the platform's
      // own *text selection* drag instead of ours. WebKit then owns the
      // gesture — the row's words highlight blue as the pointer travels
      // and no reorder happens at all. Chromium is more forgiving, so both
      // the e2e suite (headless Chromium) and the component tests pass
      // either way; only running the real Tauri bundle showed it.
      //
      // `preventDefault` on `pointerdown` is the narrow fix rather than
      // `user-select: none` on the row, which would also stop a reader
      // selecting a Task's text to copy it — a thing they can do today and
      // should keep being able to do. The handle is `aria-hidden` and not
      // focusable, so suppressing the default action here costs no focus
      // behaviour either.
      event.preventDefault();
      setDrag({ taskId, pointerId: event.pointerId });
      setOverTarget(null);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // jsdom implements no pointer capture at all (component tests
        // stub it); a real browser can also lose the pointer between the
        // event firing and this call — `use-swipe-actions.ts`'s own drag
        // hits the identical case. Nothing to recover: the drag is still
        // tracked in state above, it just isn't captured, so a pointer
        // that strays off the handle mid-drag would stop delivering moves.
      }
    };
  }

  function handleHandlePointerMove(event: PointerEvent<HTMLSpanElement>) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const originalIndex = tasks.findIndex((task) => task.id === drag.taskId);
    const { ids, rects } = measureRows(drag.taskId);
    const verdict = dropIndexForPointer(rects, event.clientY, originalIndex);
    setOverTarget(verdict.kind === "moved" ? (ids[verdict.dropIndex] ?? "end") : null);
  }

  function handleHandlePointerUp(event: PointerEvent<HTMLSpanElement>) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const { taskId, pointerId } = drag;
    try {
      event.currentTarget.releasePointerCapture(pointerId);
    } catch {
      // Already released, or capture never succeeded.
    }
    const originalIndex = tasks.findIndex((task) => task.id === taskId);
    const { rects } = measureRows(taskId);
    const verdict = dropIndexForPointer(rects, event.clientY, originalIndex);
    if (verdict.kind === "moved") {
      commitDrop(taskId, verdict.dropIndex);
    }
    // A release that resolved to "unchanged" writes nothing at all — not a
    // `reorderTask` call whose key happens to land back where it started.
    // That distinction is `dropIndexForPointer`'s own verdict, not
    // something recomputed here from before/after keys.
    setDrag(null);
    setOverTarget(null);
  }

  function handleHandlePointerCancel(event: PointerEvent<HTMLSpanElement>) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released, or capture never succeeded.
    }
    // The system took the gesture — an abort writes nothing, the same
    // contract `use-swipe-actions.ts`'s own `pointercancel` path holds for
    // a swipe.
    setDrag(null);
    setOverTarget(null);
  }

  // The one write a drop produces (task-reorder.ts's `reorderedTaskOrderKey`,
  // ADR 0050) — `dropIndex` is already in `reorderedTaskOrderKey`'s own
  // `withoutDragged` space, `dropIndexForPointer`'s own return value, so
  // there is nothing left to translate here.
  function commitDrop(draggedId: string, dropIndex: number) {
    reorderTask(draggedId, reorderedTaskOrderKey(tasks, draggedId, dropIndex));
  }

  // Completing raises the same Undo-toast affordance
  // register-service-worker.web.ts's own update prompt uses
  // (`toast(..., { action: { label, onClick } })`), mirroring that shape
  // rather than inventing a second one for this app to carry.
  //
  // This does not reopen issue #82's removal of undo-on-delete. That
  // removal exists because an Entry delete is terminal at the id level —
  // use-history.ts's own long comment on `removeEntry` explains that the
  // Server's `on conflict ... where entries.deleted_at is null` guard makes
  // reviving a deleted id impossible, so a "restore" would have to mint a
  // fresh id and diverge permanently from what every other Device already
  // converged on. Completing a Task is a different act entirely: the row
  // is not deleted, not tombstoned, not even touched at the id level —
  // `uncomplete()` just clears `completedAt` and clears `seq` the same way
  // any other edit does, and it Syncs like any other write. There is
  // nothing here for "permanently diverges" to mean.
  function handleComplete(taskId: string, content: string) {
    completeTask(taskId);
    toast(`Completed "${content}"`, {
      action: {
        label: "Undo",
        onClick: () => uncompleteTask(taskId),
      },
    });
  }

  function handleRequestDelete(taskId: string) {
    setConfirmingId(taskId);
  }

  return (
    <Shell title="Todo" back={<BackToChats />} message={message} composerSlot={<TodoNav />}>
      <AddTaskForm onAdd={addTask} disabled={disabled} />

      {tasks.length === 0 ? (
        // A real state, not a blank panel (this ticket's own acceptance
        // criterion) — the same posture `sessions-page.tsx`'s own empty
        // state takes rather than leaving a bare scroll region.
        <p className="px-3 py-6 text-center text-muted-foreground text-sm">
          Nothing in your Inbox. Add a Task above to get started.
        </p>
      ) : (
        <ul ref={listRef} className="flex flex-col">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onComplete={() => handleComplete(task.id, task.content)}
              onRequestDelete={() => handleRequestDelete(task.id)}
              isDropTarget={drag !== null && overTarget === task.id}
              onHandlePointerDown={handleHandlePointerDown(task.id)}
              onHandlePointerMove={handleHandlePointerMove}
              onHandlePointerUp={handleHandlePointerUp}
              onHandlePointerCancel={handleHandlePointerCancel}
            />
          ))}
          {/* The trailing drop zone — dropping past the last row appends
              rather than being refused for having no row to land before.
              Only meaningful while a drag is in flight; the border only
              draws then, so it costs nothing to look at otherwise. An
              `<li>`, not a `<div>`: a `<ul>`'s only valid children are list
              items, and this sits directly inside the same list every
              `TaskRow` does. It carries no pointer listeners of its own —
              unlike the old native-DnD version, "past the last row" is a
              geometry verdict `dropIndexForPointer` already produces from
              the pointer's own y, not a second drop target to wire up.
              Keyboard-accessible reordering (issue #171, named out of scope
              by this ticket's own brief) is where a real keyboard path onto
              "move to the end" would land. */}
          <li
            aria-hidden="true"
            className={`h-3 border-t-2 ${
              drag !== null && overTarget === "end" ? "border-t-primary" : "border-t-transparent"
            }`}
          />
        </ul>
      )}

      <CompletedTasks tasks={completedTasks} onUncomplete={uncompleteTask} />

      <ConfirmDialog
        open={confirmingTask !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingId(null);
          }
        }}
        title="Delete this Task?"
        description={
          confirmingTask && (
            <>
              Deleting "{confirmingTask.content}" is permanent — the row stays gone on every Device,
              and there is no Undo (unlike completing, which you can always reverse).
            </>
          )
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmingTask) {
            removeTask(confirmingTask.id);
          }
        }}
      />
    </Shell>
  );
}
