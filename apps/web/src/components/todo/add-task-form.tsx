/**
 * Todo's add field (issue #170, converted to the shared `TaskTitleEditor`
 * by issue #226) — the third of #225's "one editor, three homes," left at
 * two homes when #225 landed because no decoration plugin existed yet to
 * replace this field's own shipped recognition highlighting
 * (`lazy-task-title-editor.ts`'s own header comment records that gap).
 * `todo-quick-add-recognition.ts` is that plugin: it renders every
 * recognised match as a real `inline-block` span (quick-add.md's own "one
 * fact that decides the implementation") and implements the two-step
 * Backspace withdrawal (QA-04/QA-05) — the behaviour this whole programme
 * exists to fix.
 *
 * **No click-to-demote here.** The pre-#226 field let a click anywhere
 * inside a highlighted token demote it — a home-grown safety valve
 * (170-brief.md's Part D) built for the old input-plus-backdrop design.
 * Todoist's own reference has no such affordance for a natural-language
 * span: quick-add.md's own "Other ways to reject a recognition" section
 * finds "no dismiss affordance on the span itself" and confirms Backspace
 * is the verified path (QA-08 also confirms moving the caret INTO a
 * recognised span does nothing). Two-step Backspace replaces click-to-
 * demote rather than sitting alongside it.
 *
 * **`key={resetKey}` is how the field clears after Add.**
 * `TaskTitleEditor` seeds its document once, at mount, and never resyncs
 * it from a later `value` prop change (that file's own header comment) —
 * exactly right for a rename, wrong for a field that needs to go back to
 * empty after every submit. Bumping `resetKey` forces React to tear down
 * and remount a fresh editor (and, with it, a fresh recognition plugin
 * with no withdrawn spans left over) rather than trying to reach into a
 * live `EditorView` to clear it imperatively.
 */
import type { QuickAddOptions } from "@meologue/core";
import { parseQuickAdd } from "@meologue/core";
import { Suspense, useRef, useState } from "react";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localDayKey } from "@/lib/local-day-key";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import { type QuickAddTaskFields, taskFieldsFromQuickAdd } from "@/lib/quick-add-task";
import { useSettingsStore } from "@/lib/settings";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";

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
  /**
   * Feeds the `#`/`@` autocomplete popup (issue #226's own second half,
   * `quick-add-autocomplete.ts`'s header comment). `todo-page.tsx`'s own
   * `useEntryStore()` already holds `projects`/`labels` — this ticket's own
   * report has the exact one-line JSX change that call site still needs to
   * pass them here; this component does not fetch them itself (the same
   * "pass options in, don't have the editor reach out" convention
   * `todo-quick-add-recognition.ts`'s own `getOptions` callback already
   * follows for `now`/`smartDates`). Both default to empty, so an
   * unmigrated caller keeps building without the popup listing anything —
   * not a crash, just an always-empty list.
   */
  projects?: readonly AutocompleteEntry[];
  labels?: readonly AutocompleteEntry[];
  /** Wired to `useProjects().addProject`/`useLabels().addLabel` by a real caller — both are already fire-and-forget, name-only creators (see this ticket's own report on why that's "a clean callback path" per the brief), so selecting "Create" here needs nothing back from them. Omitted, selecting "Create" still inserts the typed token; it just mints nothing. */
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
}

// The box-model classes `Input`'s own default className carries (the
// radius, height, padding), reading its type scale from the
// `--td-composer-title-font-size`/`--td-composer-title-line-height` tokens
// (index.css, QA-20's Quick Add row) the same way task-row-content.tsx
// reads `--td-row-font-size`/`--td-row-line-height` — 16px/23px at every
// width, matching Todoist's own Quick Add title (issue #251); no `md:`
// override here because the token is not itself width-dependent. CSS
// blockifies a flex item's own `display` — an `inline-block` decoration
// span, once a direct child of a `display: flex` root, computes as
// `block` regardless of what its own class says, and stray text runs
// between flex-item children get placed in anonymous flex items rather
// than flowing inline, which is what actually broke typing: a character
// typed right at a match's own boundary landed at the wrong offset,
// corrupting the text ("tod p1" -> "todp1"). Centring vertically with the
// line-height (rather than `flex`/`items-center`) is why that matters
// here.
//
// Issue #252 dropped the resting **border** (`border-input` → `border-
// transparent`, the box kept rather than removed so focus doesn't shift
// layout) — Todoist's own end-of-list affordance is borderless (NAV-10,
// parity ledger). It deliberately did **not** touch the type-scale
// tokens above: those are #251's fix for a *different* Todoist surface
// (Quick Add's own dialog title, measured 16px/23px) reusing tokens that
// had zero consumers before it. This field plays both surfaces' roles at
// once — Todoist's quiet "+ Add task" row *and* its Quick Add title — only
// because the click-to-reveal composer that would separate them is
// deferred (NAV-12, parity ledger); reintroducing a hardcoded font-size
// beside `--td-composer-title-font-size` here would restore the exact
// dead-token defect #251 fixed. The placeholder's own colour is fixed by
// NAV-10 in `task-title-editor.tsx`'s `placeholderPlugin` widget — a
// literal value scoped to that widget, not the shared `text-muted-
// foreground` this comment used to point to before the ledger's live
// measurement caught it reading `rgb(204,204,204)` against Todoist's
// `rgb(128,128,128)`; the composed 14px figure from quick-add.md is
// Todoist's measurement of its
// *static, pre-click* label, which this field has no separate state for —
// see this ticket's own report for why narrowing the placeholder alone to
// 14px was left undone rather than hacked around a file outside this
// ticket's scope.
const EDITOR_BOX_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2.5 py-1 text-[length:var(--td-composer-title-font-size)] leading-[length:var(--td-composer-title-line-height)] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function AddTaskForm({
  onAdd,
  disabled,
  projects = [],
  labels = [],
  onCreateProject,
  onCreateLabel,
}: AddTaskFormProps) {
  const [value, setValue] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);

  // A ref, not plain state: `todo-quick-add-recognition.ts`'s plugin reads
  // `now`/`smartDates` live, on every decoration pass, through the
  // `getOptions` callback below — `extraPlugins` is itself read only once,
  // at mount (task-title-editor.tsx's own doc comment), so the plugin
  // instance is fixed for the editor's lifetime even though the OPTIONS it
  // consults (a `smartDates` toggle, a date rollover at midnight) are not.
  const optionsRef = useRef<QuickAddOptions>({ now: localDayKey(new Date()), smartDates });
  optionsRef.current = { now: localDayKey(new Date()), smartDates };

  // The identical live-ref shape, for the autocomplete popup's own
  // `getProjects`/`getLabels` — `task-title-editor.tsx`'s own `autocomplete`
  // prop doc comment on why the callbacks stay live even though the editor
  // only reads the PROP once, at mount.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  // Date-only, matching todo-page.tsx's own `captureDate` (`localDayKey`):
  // every date-rule that reads `now`
  // (../../packages/core/src/quick-add/date-rules.ts) only ever compares
  // or advances whole calendar days, never a time-of-day, so a finer "now"
  // would add nothing this parser could use.
  function commit(text: string) {
    const options = optionsRef.current;
    // The plain, undemoted parse of whatever the field currently holds —
    // deliberately not aware of the recognition plugin's own withdrawn
    // spans (those live inside the ProseMirror plugin's state, not here).
    // A match withdrawn a moment ago by Backspace still resolves its Task
    // field if the reader hits Add without editing further; narrowing
    // that is left to a later pass, the same way this ticket's own scope
    // note leaves the footer controls and a typed `#project` on save for
    // later.
    const result = parseQuickAdd(text, options);
    const fields = taskFieldsFromQuickAdd(text, result, options);
    // A token-only line (typing just "tomorrow" with nothing else) parses
    // to empty `content` — silently doing nothing here mirrors
    // use-tasks.ts's own addTask/renameTask, both of which already treat
    // trimmed-empty as "nothing to add" rather than a Task with no words.
    if (fields.content.trim() === "") {
      return;
    }
    onAdd(fields);
    setValue("");
    setResetKey((key) => key + 1);
  }

  return (
    // Issue #252: was `border-t border-border p-3` — a boxed panel sitting
    // above the list. Now a quiet, borderless row (Todoist's own end-of-
    // list "+ Add task" affordance, NAV-10) sitting after it instead; see
    // `EDITOR_BOX_CLASSES`'s own header comment above for what did and
    // didn't change about the field's own type scale.
    <div className="flex items-center gap-2 px-3 py-2">
      {/*
        KBD-04 (parity ledger): Todoist's own "Add task" affordance is a
        plain `<button>` and joins the row-to-row cycle as one stop
        (`docs/reference/todoist/live-audit-dom/flow6-KBD-04-todoist.json`'s
        `isAddTaskBtn`). This app's own affordance is the field itself —
        `AddTaskForm`'s own header comment on playing "Todoist's quiet
        '+ Add task' row *and* its Quick Add title" at once — so there is
        no separate button to mark. The live focusable element inside this
        wrapper (`LazyTaskTitleEditor`'s own `role="textbox"` div, or the
        disabled placeholder `Input` before Todo's store has opened) is
        `TaskTitleEditor` (task-title-editor.tsx), the identical shared
        component a Task's own inline rename and the detail view's editor
        also mount — marking that component's own DOM node directly would
        make every in-place rename a cycle stop too. Marking this wrapper
        instead, and having `use-todo-keymap.ts`'s `focusAdjacentRow` look
        up its one live focusable descendant, keeps the cycle's landing
        point specific to *this* editor without touching the shared file.
      */}
      <div className="relative flex-1" data-add-task-field>
        {disabled ? (
          // No point mounting a live editor (and its recognition plugin)
          // while there is nowhere yet to send what it would parse —
          // matching `todo-page.tsx`'s own "store hasn't opened yet"
          // posture.
          <Input
            placeholder="Add task"
            aria-label="Add task"
            disabled
            className="border-transparent"
          />
        ) : (
          <Suspense
            // No `aria-label` here, deliberately: the real editor below
            // carries the identical `aria-label="Add task"`, and a
            // labelled fallback with the same accessible name is
            // indistinguishable from it to `findByLabelText` — a test
            // awaiting "the field is ready" would resolve on this
            // fallback the instant it mounts, before the lazy import
            // settles, rather than actually waiting.
            fallback={
              <Input
                placeholder="Add task"
                aria-hidden="true"
                disabled
                tabIndex={-1}
                className="border-transparent"
              />
            }
          >
            <LazyTaskTitleEditor
              key={resetKey}
              value=""
              ariaLabel="Add task"
              placeholder="Add task"
              autoFocus={false}
              commitOnBlur={false}
              onChange={setValue}
              onCommit={commit}
              // Quick Add is an always-present row, not a dialog with a
              // "discard the draft" affordance to fall back to — Escape
              // leaves whatever's typed exactly where it is.
              onCancel={() => undefined}
              className={EDITOR_BOX_CLASSES}
              extraPlugins={[quickAddRecognitionPlugin(() => optionsRef.current)]}
              autocomplete={{
                getProjects: () => projectsRef.current,
                getLabels: () => labelsRef.current,
                onCreateProject,
                onCreateLabel,
              }}
            />
          </Suspense>
        )}
      </div>
      <Button
        type="button"
        onClick={() => commit(value)}
        disabled={disabled || value.trim() === ""}
      >
        Add
      </Button>
    </div>
  );
}
