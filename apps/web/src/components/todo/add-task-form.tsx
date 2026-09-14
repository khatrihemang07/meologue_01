/**
 * Todo's in-list add-task affordance (issue #170, converted to the shared
 * `TaskTitleEditor` by #226, rebuilt collapsed-by-default by issue #260 —
 * NAV-10/NAV-12, parity ledger).
 *
 * **Collapsed by default, expands on click.** Todoist's own reference
 * (NAV-12, quick-add.md § Quick Add chrome) is explicit: the resting
 * affordance is a static `<button>` reading "Add task" — 14px,
 * `rgb(128,128,128)`, no border — that expands into a real composer only
 * once clicked. Issue #252 already matched the resting row's *position*
 * (after the list) and *weight* (borderless, 14px) but deliberately left
 * this click-to-reveal behaviour unbuilt, naming it NAV-12's own scope
 * note: folding it in at the time would have broken every test and the
 * e2e add-task flow, which assumed an always-mounted, always-open field.
 * This file is that deferred half.
 *
 * **Shared add logic, not forked.** The actual parse/commit — `value`,
 * `resetKey`, the recognition plugin, the `#`/`@` autocomplete — all live
 * in `use-quick-add-composer.ts`, shared verbatim with `quick-add-
 * dialog.tsx` (issue #260's own brief: "don't fork the add logic"). This
 * component only owns the collapsed/expanded chrome around it.
 *
 * **Collapses on Cancel or Escape** (NAV-12's own claim), both routed
 * through the identical `collapse` callback below — but does **not**
 * collapse after a successful Add (issue #260's Defect 1). A previous
 * version of this comment cited QA-19 for the opposite behaviour
 * ("collapses again after a successful Add, not 'stays open for the next
 * task'"); that citation was misapplied. QA-19 measured `Shift+Enter`
 * inside the global Quick Add *dialog* (`quick-add-dialog.tsx`) — a
 * different surface, where closing on commit IS correct and still
 * happens there. It says nothing about this in-list composer's Add
 * button. What actually governs this component is the flow-12 S1 live
 * drive (2026-09-13): Todoist's own in-list composer, after Add,
 * "stayed mounted, EMPTY, and focused — does NOT collapse"
 * (`meologue-parity-docs/todoist/live-audit-dom/flow12-S1-NAV-07-10-12-
 * both.json`). The two findings do not conflict — they describe two
 * different surfaces, each still true on its own. `keyboard.md`'s own
 * "Add task" section transcribes Enter as "Save new task and create
 * another one below," which reads closer to the corrected behaviour, but
 * that transcription is still UNVERIFIED (`keyboard.md`'s own header
 * warns the whole keymap table is transcription-only unless a row is
 * separately marked verified) — this file follows the live-driven flow-12
 * S1 record, not the transcription, per this ticket's own instruction to
 * prefer the verified source when the two disagree.
 */
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

// Reads `--td-add-task-font-size`/`--td-add-task-placeholder` (index.css,
// NAV-10) — the resting row's own measured 14px/`rgb(128,128,128)`, not
// the Quick Add title's 16px/23px pair (`--td-composer-title-*`), which
// only applies once the composer is actually open below.
const TRIGGER_CLASSES =
  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[length:var(--td-add-task-font-size)] text-[color:var(--td-add-task-placeholder)] hover:text-foreground disabled:pointer-events-none disabled:opacity-60";

// The open composer's own box — a bordered card now that it is a genuine,
// transient editor rather than the permanent resting row (issue #252's
// borderless `border-transparent` applied to the *collapsed* trigger
// above instead; see that issue's own history in this file's git log for
// why the always-open field used to carry this class name for a different
// reason). Reads the identical `--td-composer-title-font-size`/`-line-
// height` tokens QA-20 fixed, at every width, matching Todoist's own
// Quick Add title (16px/23px) once a reader has actually clicked in.
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
        {/*
          KBD-04 (parity ledger): Todoist's own "Add task" affordance is a
          plain `<button>` and is itself the row-to-row cycle's one
          non-row stop (`flow11-R2-...`'s own measured traversal) —
          `data-row-nav-target` marks this button directly as that stop,
          the same way `completed-tasks.tsx`'s Restore button and
          `task-row-content.tsx`'s title button mark themselves
          (`todo-keymap.ts`'s own `rowNavTargets` reads this attribute
          live, off the tree, so marking it here needs no change there).
          Once expanded below, the cycle's stop shifts onto the editor's
          own `role="textbox"` instead (the existing `[data-add-task-
          field] [role="textbox"]` selector already covers that).
        */}
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
