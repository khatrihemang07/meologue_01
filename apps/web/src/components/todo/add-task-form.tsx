import { useEffect, useState } from "react";
import { touchOnlyDevice } from "@/lib/pointer";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { FOCUS_ADD_TASK_EVENT } from "@/lib/todo-keymap";
import { useQuickAddComposer } from "@/lib/use-quick-add-composer";
import { QuickAddContent } from "./quick-add-content";
import { QuickAddInlineCard } from "./quick-add-inline-card";
import { QuickAddSheet } from "./quick-add-sheet";

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
  datesWithTasks?: ReadonlyMap<string, number>;
  ambientProjectName?: string;
}

const TRIGGER_CLASSES =
  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[length:var(--td-quick-add-placeholder-font-size)] text-[color:var(--td-quick-add-placeholder)] hover:text-foreground disabled:pointer-events-none disabled:opacity-60";

/**
 * Todoist web's own inline "+ Add task" row (Surface B, `web/01-
 * anatomy.md`) — always mounted, byte-for-byte the same subtree as the
 * global Quick Add once expanded (now `QuickAddContent`, shared via
 * `quick-add-dialog.tsx`). Only this component's own collapsed<->expanded
 * trigger shape is specific to it; the expanded surface itself is
 * `QuickAddInlineCard`/`QuickAddSheet`, chosen the identical way
 * `quick-add-dialog.tsx` does.
 */
export function AddTaskForm({
  onAdd,
  disabled,
  projects = [],
  labels = [],
  onCreateProject,
  onCreateLabel,
  datesWithTasks,
  ambientProjectName,
}: AddTaskFormProps) {
  const [open, setOpen] = useState(false);
  const touch = touchOnlyDevice();

  // Issue #260 Defect 2: `todo-keymap.ts`'s `focusAddTaskField()` has no
  // reference to this component's own `open` state — private `useState`,
  // by design, the identical "no external door" gap `OPEN_SCHEDULE_EVENT`
  // and `OPEN_COMMAND_MENU_EVENT` solve one component over (those
  // constants' own doc comments in `todo-keymap.ts`) — so it dispatches
  // `FOCUS_ADD_TASK_EVENT` on `document` instead, but only when its own
  // selector-based fast path finds no live textbox/input already
  // mounted, i.e. only while this composer is still the collapsed
  // resting row. This listener is the other half: reveal on that event,
  // the same way the trigger button's own `onClick` below does.
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
    open,
    onCommitted: () => {
      if (!touch) {
        setOpen(false);
      }
    },
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

  const content = (
    <QuickAddContent
      composer={composer}
      touch={touch}
      placeholder={composer.placeholder}
      datesWithTasks={datesWithTasks}
      ambientProjectName={touch ? "Inbox" : ambientProjectName}
      onCancel={collapse}
    />
  );

  // Touch: the identical full-screen sheet `quick-add-dialog.tsx`'s FAB
  // opens — Android has no inline add row of its own to diverge from
  // (issue #283/#304's own scope), so if this trigger is ever reached on
  // a touch device it still gets D16's real touch shell, not a second,
  // narrower one. Non-touch: `QuickAddInlineCard` rendered in place, no
  // Dialog/Portal at all — this row has to stay a real sibling in the
  // list, not relocate to `document.body` (that component's own header
  // comment has the full reasoning).
  if (touch) {
    return (
      <QuickAddSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            collapse();
          }
        }}
        ariaLabel="Add task"
        markAddTaskField
      >
        {content}
      </QuickAddSheet>
    );
  }

  return <QuickAddInlineCard data-add-task-field>{content}</QuickAddInlineCard>;
}
