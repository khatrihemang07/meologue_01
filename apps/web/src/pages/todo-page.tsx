import type { DragEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { Shell } from "@/components/shell";
import { AddTaskForm } from "@/components/todo/add-task-form";
import { CompletedTasks } from "@/components/todo/completed-tasks";
import { TaskRow } from "@/components/todo/task-row";
import { TodoNav } from "@/components/todo/todo-nav";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
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

  // Drag state (ADR 0050): `draggedId` names the Task the pointer picked
  // up, `overTarget` names where it would land if released right now —
  // either another Task's id (insert before that row) or `"end"` (the
  // trailing drop zone below the last row, append after everything).
  // Neither persists anything on its own; `commitDrop` below is the one
  // place that turns this state into the single `reorderTask` call ADR
  // 0050 requires.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overTarget, setOverTarget] = useState<string | "end" | null>(null);

  function handleDragStart(taskId: string) {
    return (event: DragEvent<HTMLLIElement>) => {
      setDraggedId(taskId);
      // Guarded rather than assumed present: real browsers always supply
      // `dataTransfer` for a native drag event, but jsdom's synthetic one
      // (todo-page.test.tsx's own drag simulation) does not, and this line
      // is cosmetic — it only shapes the OS-level drag cursor — not load-
      // bearing for anything `commitDrop` below actually does.
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
      }
    };
  }

  function handleDragOverRow(taskId: string) {
    return (event: DragEvent<HTMLLIElement>) => {
      // A drop is refused by default on every element — preventDefault is
      // what the browser's native drag-and-drop uses to mean "this is a
      // valid drop target," the same native contract `onDrop` below relies
      // on to fire at all.
      event.preventDefault();
      setOverTarget(taskId);
    };
  }

  function handleDropOnRow(taskId: string) {
    return (event: DragEvent<HTMLLIElement>) => {
      event.preventDefault();
      commitDrop(taskId);
    };
  }

  function handleDragOverEnd(event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    setOverTarget("end");
  }

  function handleDropAtEnd(event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    commitDrop("end");
  }

  function handleDragEnd() {
    setDraggedId(null);
    setOverTarget(null);
  }

  // The one write a drop produces (task-reorder.ts's `reorderedTaskOrderKey`,
  // ADR 0050) — `target` is either the id of the row the dragged Task is
  // dropping before, or `"end"` for the trailing zone past the last row.
  // Both resolve to the same `dropIndex` shape that function expects:
  // "end" means the position past every remaining Task once the dragged
  // one is filtered out.
  function commitDrop(target: string | "end") {
    if (draggedId === null) {
      return;
    }
    const withoutDragged = tasks.filter((task) => task.id !== draggedId);
    const dropIndex =
      target === "end"
        ? withoutDragged.length
        : withoutDragged.findIndex((task) => task.id === target);
    reorderTask(draggedId, reorderedTaskOrderKey(tasks, draggedId, dropIndex));
    setDraggedId(null);
    setOverTarget(null);
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
        <ul className="flex flex-col">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onComplete={() => handleComplete(task.id, task.content)}
              onRequestDelete={() => handleRequestDelete(task.id)}
              isDropTarget={draggedId !== null && overTarget === task.id}
              onDragStart={handleDragStart(task.id)}
              onDragOver={handleDragOverRow(task.id)}
              onDrop={handleDropOnRow(task.id)}
              onDragEnd={handleDragEnd}
            />
          ))}
          {/* The trailing drop zone — dropping past the last row appends
              rather than being refused for having no row to land before.
              Only meaningful while a drag is in flight; the border only
              draws then, so it costs nothing to look at otherwise. An
              `<li>`, not a `<div>`: a `<ul>`'s only valid children are list
              items, and this sits directly inside the same list every
              `TaskRow` does. Mouse-drag-only, same as `TaskRow`'s own
              draggable row — issue #171 (keyboard-accessible reordering,
              named out of scope by this ticket's own brief) is where a
              real keyboard path onto "move to the end" would land. */}
          <li
            aria-hidden="true"
            onDragOver={handleDragOverEnd}
            onDrop={handleDropAtEnd}
            className={`h-3 border-t-2 ${
              draggedId !== null && overTarget === "end"
                ? "border-t-primary"
                : "border-t-transparent"
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
