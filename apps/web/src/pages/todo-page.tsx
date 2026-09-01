import type { PointerEvent } from "react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { localDayKey } from "@/components/date-picker-sheet";
import { Shell } from "@/components/shell";
import { AddTaskForm } from "@/components/todo/add-task-form";
import { CompletedTasks } from "@/components/todo/completed-tasks";
import { TaskRow } from "@/components/todo/task-row";
import { TaskScheduleSheet } from "@/components/todo/task-schedule-sheet";
import { TodayView } from "@/components/todo/today-view";
import { TodoNav } from "@/components/todo/todo-nav";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { dropIndexForPointer } from "@/lib/task-drag-recognizer";
import { reorderedTaskOrderKey } from "@/lib/task-reorder";
import { useEntryStore } from "@/pages/entry-store-layout";

export interface TodoPageProps {
  /**
   * Which of Todo's two views to render (issue #169) — a prop, not a
   * second lazily-imported page component, so `App.tsx` keeps exactly one
   * dynamic `import("@/pages/todo-page")` regardless of how many `/todo/*`
   * routes exist. Two Route elements pointing at the same lazy component
   * with different props is what keeps this a one-chunk feature the way
   * `apps/web/scripts/check-bundle-size.mjs`'s own per-chunk budget
   * expects — a second chunk here would need a second budget entry this
   * ticket's brief never asked for ("update the Todo chunk's budget,"
   * singular). Defaults to "inbox" so every pre-#169 caller — this file's
   * own tests among them — that renders `<TodoPage />` with no props at
   * all keeps working unchanged.
   */
  view?: "inbox" | "today";
}

/**
 * Todo's two views (issue #168's Inbox, issue #169's Today) — ADR 0049
 * names both as `/todo/*` routes rendered through this one lazy chunk, and
 * this component is the seam that picks between them via `view` rather
 * than each view owning its own page module. Inbox lists every active
 * Task in `(orderKey, id)` order (TaskStore.list()'s own guarantee) with
 * the ordinary CRUD-plus-reorder set issue #168's acceptance criteria
 * name: add, complete (with an Undo toast and a durable Completed section
 * — see the comment on `handleComplete` below), uncomplete, delete (behind
 * the shared `ConfirmDialog`, same as `sessions-page.tsx`/`history.tsx`),
 * and drag-to-reorder. Today (`components/todo/today-view.tsx`) is a
 * second, co-equal query over the same Tasks, with no drag-to-reorder of
 * its own — task-views.ts's `today()` computes its order, so there's
 * nothing for a drag to mean there the way there is in Inbox.
 *
 * Renders through `Shell` the same way every other Destination does,
 * `composerSlot={<TodoNav />}` docking Todo's own internal navigation at
 * the pane's bottom edge, regardless of which view is open — the nav's own
 * job is showing a reader where else in Todo they can go, which is exactly
 * as true from Today as it is from Inbox.
 *
 * The Add form, the Completed disclosure, the delete confirmation, and the
 * schedule sheet (issue #169's pickers) are all owned here, once, and
 * shared by both views rather than each growing its own copy: deleting or
 * scheduling a Task is the identical act regardless of which view's row a
 * reader tapped it from.
 *
 * The Add form is shared too, but it is **not** context-free — see
 * `captureDate` below.
 */
export function TodoPage({ view = "inbox" }: TodoPageProps = {}) {
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
    setTaskDate,
    setTaskDeadline,
    setTaskDuration,
    setTaskPriority,
    advanceRecurringTask,
    completeForeverTask,
    postponeTask,
    resolveLabelIds,
  } = useEntryStore();

  // The date a Task captured *from this view* inherits — the plan's
  // "default date is inherited from origin" rule, which is Todoist's own
  // context inheritance. Inbox is the undated capture bucket (issue #169's
  // "a Task created in Todo starts undated"), so it inherits nothing;
  // Today inherits today.
  //
  // Not a nicety. With Inbox's rule applied to both views, typing a Task
  // while standing on Today made it disappear as it was added — it was
  // created undated, and an undated Task is by definition absent from
  // every day-keyed view (task-views.ts). That was verified on the built
  // app, not reasoned about: the row simply never appeared. "Created in
  // Todo" is not one origin; the view a reader is standing in is the
  // context, and this is the line that says so.
  //
  // `localDayKey`, not `new Date().toISOString()`: Task.date is a floating
  // local day (its own doc comment in packages/core), and an ISO instant
  // would put a Task captured late in the evening onto tomorrow for any
  // reader east of UTC — the same reason `today-view.tsx` reads the
  // current day through this function rather than off an instant.
  const captureDate = view === "today" ? localDayKey(new Date()) : null;

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmingTask = tasks.find((task) => task.id === confirmingId) ?? null;

  // The one TaskScheduleSheet instance for the whole page (this
  // component's own doc comment) — `schedulingId` names which Task it's
  // currently open for, `null` meaning closed. Looked up fresh from
  // `tasks` on every render (`schedulingTask` below) rather than a
  // snapshot captured when the sheet opened, so a picker's own write is
  // visible in the sheet the instant the next render lands (TanStack
  // Query's cache update after `afterLocalWrite`, use-tasks.ts).
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const schedulingTask = tasks.find((task) => task.id === schedulingId) ?? null;

  function handleOpenSchedule(taskId: string) {
    setSchedulingId(taskId);
  }

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
  // `dateString` decides which mutation "completing" actually means
  // (issue #170): a recurring Task (`dateString !== null`) never enters
  // the completed list at all (TaskStore.advanceRecurring's own doc
  // comment — "the checkbox does not un-tick itself"), so there is
  // nothing here for the Undo toast to reverse and none is offered; the
  // row itself already shows the next occurrence the moment this
  // component re-renders.
  function handleComplete(taskId: string, content: string, dateString: string | null) {
    if (dateString !== null) {
      advanceRecurringTask(taskId);
      return;
    }
    completeTask(taskId);
    toast(`Completed "${content}"`, {
      action: {
        label: "Undo",
        onClick: () => uncompleteTask(taskId),
      },
    });
  }

  // Ends a recurring Task's series (TaskStore.completeForever's own doc
  // comment) — reached via Shift+Click on the checkbox or the touch-
  // reachable button (task-row.tsx). Undo is still offered — `uncomplete()`
  // clears `completedAt` unconditionally — but it only restores an
  // ordinary, non-recurring active Task: `completeForever` also clears
  // `dateString` for good, and undoing a completion has never been this
  // programme's mechanism for restoring a rule that was deliberately
  // ended (`uncomplete`'s own doc comment never claims otherwise). The
  // toast's own wording says so, rather than promising more than Undo
  // actually gives back.
  function handleCompleteForever(taskId: string, content: string) {
    completeForeverTask(taskId);
    toast(`Completed "${content}" — the recurrence has ended`, {
      action: {
        label: "Undo",
        onClick: () => uncompleteTask(taskId),
      },
    });
  }

  function handleRequestDelete(taskId: string) {
    setConfirmingId(taskId);
  }

  // The add field's own parse (add-task-form.tsx, quick-add-task.ts)
  // resolves everything except `labelIds` — a `%label` name needs a
  // LabelStore round trip (use-labels.ts's `resolveLabelIds`) this
  // function is what awaits before a Task literal can be built at all.
  // `fields.date` overrides `captureDate` only when the reader actually
  // typed a date/time token or a recurrence resolved one (quick-add-
  // task.ts's own doc comment on why `??` — not the view's own inherited
  // date — is the fallback direction): what was typed always wins over
  // what the view merely suggested.
  async function handleAdd(fields: QuickAddTaskFields) {
    const labelIds = await resolveLabelIds(fields.labelNames);
    addTask(fields.content, {
      date: fields.date ?? captureDate,
      deadline: fields.deadline,
      duration: fields.duration,
      priority: fields.priority,
      dateString: fields.dateString,
      labelIds,
    });
  }

  return (
    <Shell title="Todo" back={<BackToChats />} message={message} composerSlot={<TodoNav />}>
      <AddTaskForm onAdd={handleAdd} disabled={disabled} />

      {view === "today" ? (
        <TodayView
          tasks={tasks}
          onComplete={handleComplete}
          onCompleteForever={handleCompleteForever}
          onRequestDelete={handleRequestDelete}
          onOpenSchedule={handleOpenSchedule}
          onSetDate={setTaskDate}
          onPostpone={postponeTask}
        />
      ) : tasks.length === 0 ? (
        // A real state, not a blank panel (issue #168's own acceptance
        // criterion) — the same posture `sessions-page.tsx`'s own empty
        // state takes rather than leaving a bare scroll region. Today's
        // own empty state (`today-view.tsx`) reads differently on
        // purpose — see that file's own comment.
        <p className="px-3 py-6 text-center text-muted-foreground text-sm">
          Nothing in your Inbox. Add a Task above to get started.
        </p>
      ) : (
        <ul ref={listRef} className="flex flex-col">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onComplete={() => handleComplete(task.id, task.content, task.dateString)}
              onCompleteForever={() => handleCompleteForever(task.id, task.content)}
              onRequestDelete={() => handleRequestDelete(task.id)}
              onOpenSchedule={() => handleOpenSchedule(task.id)}
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

      {/* The Completed disclosure is Inbox-specific — Today's own Tasks
          are never completed *from* Today in a way that would need a
          second copy of this list; completing a Task from either view
          moves it into the identical shared `completedTasks`, and this is
          Todo's one door onto it, the same reasoning `handleComplete`'s
          own doc comment gives for the schedule sheet being shared rather
          than per-view. */}
      {view === "inbox" && <CompletedTasks tasks={completedTasks} onUncomplete={uncompleteTask} />}

      {schedulingTask !== null && (
        <TaskScheduleSheet
          task={schedulingTask}
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setSchedulingId(null);
            }
          }}
          onSetDate={setTaskDate}
          onSetDeadline={setTaskDeadline}
          onSetDuration={setTaskDuration}
          onSetPriority={setTaskPriority}
        />
      )}

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
