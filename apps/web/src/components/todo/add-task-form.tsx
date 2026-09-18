import { Suspense, useEffect, useState } from "react";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { FOCUS_ADD_TASK_EVENT } from "@/lib/todo-keymap";
import { useQuickAddComposer } from "@/lib/use-quick-add-composer";

export interface AddTaskFormProps {
  /**
   * Already-resolved Task fields (quick-add-task.ts) except `labelIds` —
   * resolving a `@label` name to an id needs a LabelStore round trip
   * (use-labels.ts's `resolveLabelIds`), which this component has no
   * reason to know about; todo-page.tsx's own caller is what awaits that
   * and reconciles `fields.date` against the view's inherited date before
   * it ever calls `addTask`.
   */
  onAdd: (fields: QuickAddTaskFields) => void;
  disabled: boolean;
  /** Feeds the `#`/`@` autocomplete popup — `todo-page.tsx`'s own `useEntryStore()` already holds `projects`/`labels`. Both default to empty, so an unmigrated caller keeps building without the popup listing anything — not a crash, just an always-empty list. */
  projects?: readonly AutocompleteEntry[];
  labels?: readonly AutocompleteEntry[];
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
}

const TRIGGER_CLASSES =
  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[length:var(--td-add-task-font-size)] text-[color:var(--td-add-task-placeholder)] hover:text-foreground disabled:pointer-events-none disabled:opacity-60";

const EDITOR_BOX_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-transparent bg-transparent px-1 py-1 text-[length:var(--td-composer-title-font-size)] leading-[length:var(--td-composer-title-line-height)] outline-none";

export function AddTaskForm({
  onAdd,
  disabled,
  projects = [],
  labels = [],
  onCreateProject,
  onCreateLabel,
}: AddTaskFormProps) {
  const [open, setOpen] = useState(false);

  // Issue #260 Defect 2: `todo-keymap.ts`'s `focusAddTaskField()` has no
  // reference to this component's own `open` state — private `useState`,
  // by design, the identical "no external door" gap `OPEN_SCHEDULE_EVENT`
  // and `OPEN_COMMAND_MENU_EVENT` solve one component over (those
  // constants' own doc comments in `todo-keymap.ts`) — so it dispatches
  // `FOCUS_ADD_TASK_EVENT` on `document` instead, but only when its own
  // selector-based fast path finds no live textbox/input already
  // mounted, i.e. only while this composer is still the collapsed
  // resting row. This listener is the other half: reveal on that event,
  // the same way the trigger button's own `onClick` below does. The
  // existing `autoFocus={true}` on `LazyTaskTitleEditor` below lands the
  // caret once it mounts — no separate focus call needed here.
  useEffect(() => {
    function onFocusAddTask() {
      setOpen(true);
    }
    document.addEventListener(FOCUS_ADD_TASK_EVENT, onFocusAddTask);
    return () => document.removeEventListener(FOCUS_ADD_TASK_EVENT, onFocusAddTask);
  }, []);

  const composer = useQuickAddComposer({
    onAdd,
    projects,
    labels,
    onCreateProject,
    onCreateLabel,
    // No `onCommitted` here, deliberately: it used to collapse the
    // composer back to the quiet row after a real Add (this file's own
    // header comment explains why that was wrong, and issue #260 Defect
    // 1 reverses it). `composer.commit()` itself already clears
    // `value`/`seed` and bumps `resetKey`, which remounts a fresh, empty,
    // autofocused editor — exactly flow-12 S1's observed "stayed
    // mounted, EMPTY, and focused" behaviour, with nothing further
    // needed from this component.
  });

  function collapse() {
    setOpen(false);
  }

  // Before Todo's store has opened, there is nothing yet to send a
  // committed Task to — matches `todo-page.tsx`'s own "store hasn't
  // opened yet" posture. Rendered as the identical disabled trigger
  // rather than a second, differently-shaped placeholder.
  if (disabled) {
    return (
      <div className="px-3 py-2">
        <button type="button" disabled aria-label="Add task" className={TRIGGER_CLASSES}>
          Add task
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="px-3 py-2" data-add-task-field>
        <button
          type="button"
          data-row-nav-target
          aria-label="Add task"
          className={TRIGGER_CLASSES}
          onClick={() => setOpen(true)}
        >
          Add task
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2"
      data-add-task-field
    >
      <Suspense
        fallback={
          <Input aria-hidden="true" disabled tabIndex={-1} className="border-transparent" />
        }
      >
        <LazyTaskTitleEditor
          key={composer.resetKey}
          value={composer.seed}
          ariaLabel="Task name"
          placeholder="Add task"
          autoFocus={true}
          commitOnBlur={false}
          onChange={composer.setValue}
          onCommit={composer.commit}
          onCancel={collapse}
          className={EDITOR_BOX_CLASSES}
          extraPlugins={composer.extraPlugins}
          autocomplete={composer.autocomplete}
        />
      </Suspense>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={collapse}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => composer.commit(composer.value)}
          disabled={composer.value.trim() === ""}
        >
          Add task
        </Button>
      </div>
    </div>
  );
}
