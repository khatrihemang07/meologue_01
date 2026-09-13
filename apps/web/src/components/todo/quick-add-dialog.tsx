/**
 * The global Quick Add modal (issue #260 — NAV-07, QA-13/QA-15/QA-16/
 * QA-18, PRI-04, parity ledger). Opened from anywhere in Todo — the
 * sidebar's "Add task" button (`todo-sidebar.tsx`) and the `q` key
 * (`todo-keymap.ts`'s `quick-add` binding, driven live in `keyboard.md`'s
 * own "Quick Add (opened with Q for inspection only...)" capture) both
 * dispatch `OPEN_QUICK_ADD_EVENT`, which `todo-page.tsx` listens for and
 * turns into this dialog's own `open` state — the identical document-event
 * fan-in `OPEN_COMMAND_MENU_EVENT`/`OPEN_SCHEDULE_EVENT` already use
 * (`todo-keymap.ts`'s own doc comments), needed here because the sidebar
 * sits outside `EntryStoreLayout`'s Outlet and cannot call `handleAdd`
 * directly (`todo-sidebar.tsx`'s own header comment on that structural
 * split).
 *
 * **Geometry, from the one live-measured artifact this ticket has**
 * (`docs/reference/todoist/live-audit-dom/quickadd-dialog-todoist.json`,
 * identity asserted `role="dialog"` `aria-label="Quick Add"`, dark theme):
 * 580×66px at rest, 580×97px once a date is recognised, radius 12px,
 * padding 16px on all four sides, border `1px solid rgb(61,61,61)`,
 * background `rgb(40,40,40)`, shadow `rgba(0,0,0,.2) 0 4px 8px`. Width,
 * padding, radius, border and background all read off
 * `--td-composer-*`/`--muted-foreground`-adjacent tokens `index.css`
 * already declares (QA-16's own "trap for whoever builds this": those
 * tokens existed with zero consumers before this file). Height is NOT
 * set explicitly anywhere below — 66px vs 97px is what the box model
 * already produces once the Remove-date row is conditionally rendered,
 * not a value this component chooses.
 *
 * **Footer — the recorded subset, not the full described one.**
 * `quick-add.md` describes six footer controls (More actions, Select
 * project, Set date, Set priority, Add labels, then Cancel/Add task);
 * the live DOM capture only pins down four by `aria-label` — More
 * actions, Remove date, Cancel, Add task (`qa15_footerButtons` in the
 * artifact above) — the other three were never confirmed to carry an
 * aria-label at all (QA-15's own "Not established" caveat). This dialog
 * builds exactly the four that are actually pinned down, in the order
 * QA-18 measured (`Tab` from the title lands on More actions first).
 * Project/priority/label PICKERS are a different ticket's surface
 * (`task-schedule-popover.tsx`) and are not duplicated here; PRI-04's own
 * pill is shown instead, using whatever priority the shared parse already
 * recognised, since the composer already carries that information whether
 * or not a dedicated "Set priority" button exists yet.
 *
 * **Escape vs. the `#`/`@` popup — the Radix trap `task-title-editor.tsx`
 * names but cannot fix alone.** Radix's `DismissableLayer` (what
 * `Dialog.Content` is built on) wires its own Escape handler on
 * `document`, capture phase, BEFORE the contenteditable's own bubble-phase
 * keydown handler ever runs (confirmed against
 * `@radix-ui/react-dismissable-layer`'s own source: `addEventListener(...,
 * { capture: true })`, and its handler calls `onDismiss()` — closing this
 * dialog — unless the consumer's own `onEscapeKeyDown` called
 * `preventDefault()` first). Crucially that handler never calls
 * `stopPropagation()`, so the native keydown still reaches the editor's
 * own bubble handler afterwards **as long as this dialog didn't just
 * close out from under it**. `onAutocompleteOpenChange` (wired through
 * both composer instances below) is the one signal this dialog has for
 * "is a popup open right now" — `Content`'s own `onEscapeKeyDown` reads it
 * and calls `preventDefault()` while true, so Radix leaves the dialog
 * alone and the keystroke goes on to reach `quick-add-autocomplete.ts`'s
 * own `handleKeyDown`, which (registered ahead of the commit keymap,
 * `task-title-editor.tsx`'s `buildTitlePlugins`) closes just the popup.
 */
import { parseQuickAdd, uiPriorityOf } from "@meologue/core";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Suspense, useRef } from "react";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { Button } from "@/components/ui/button";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import { type QuickAddTaskFields, taskFieldsForRename } from "@/lib/quick-add-task";
import { priorityPickerColour } from "@/lib/task-priority-colors";
import { useQuickAddComposer } from "@/lib/use-quick-add-composer";
import { cn } from "@/lib/utils";

export interface QuickAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (fields: QuickAddTaskFields) => void;
  projects?: readonly AutocompleteEntry[];
  labels?: readonly AutocompleteEntry[];
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
}

// A `date`-family token span, spliced out of the raw text by "Remove
// date" below. Not established by any record how Todoist's own control
// edits the text (no artifact ever clicked it) — this is a best-effort
// reimplementation, not a measured behaviour; flagged in this ticket's
// own report rather than presented as verified.
const DATE_FAMILY_KINDS = new Set(["date", "time", "recurrence"]);

function stripDateTokens(
  text: string,
  tokens: readonly { kind: string; start: number; end: number }[],
): string {
  const spans = tokens
    .filter((token) => DATE_FAMILY_KINDS.has(token.kind))
    .slice()
    .sort((a, b) => b.start - a.start);
  let result = text;
  for (const span of spans) {
    result = result.slice(0, span.start) + result.slice(span.end);
  }
  return result.replace(/\s+/g, " ").trim();
}

// 580px at every width the record measured, capped so a narrow viewport
// never overflows — the record itself only ever measured one width.
const DIALOG_CLASSES =
  "fixed top-1/2 left-1/2 z-50 w-[580px] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[length:var(--td-composer-radius)] border border-[color:var(--td-composer-border)] bg-[color:var(--td-composer-background)] p-4 text-foreground shadow-[0_4px_8px_rgba(0,0,0,0.2)] outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const EDITOR_BOX_CLASSES =
  "w-full min-w-0 bg-transparent text-[length:var(--td-composer-title-font-size)] leading-[length:var(--td-composer-title-line-height)] outline-none";

export function QuickAddDialog({
  open,
  onOpenChange,
  onAdd,
  projects = [],
  labels = [],
  onCreateProject,
  onCreateLabel,
}: QuickAddDialogProps) {
  // A ref, not state: this only ever needs to be read out-of-band, from
  // `Content`'s own `onEscapeKeyDown` handler below — the identical
  // "no render needed, just a fresh read at fire-time" shape
  // `todo-keymap.ts`'s own `focusedTaskId()` already uses.
  const autocompleteOpenRef = useRef(false);

  const composer = useQuickAddComposer({
    onAdd,
    projects,
    labels,
    onCreateProject,
    onCreateLabel,
    // QA-19 (matched, live-driven): Shift+Enter closed/cleared Quick Add
    // on both sides — the whole dialog, not just the field, for this
    // surface.
    onCommitted: () => onOpenChange(false),
  });

  // Live preview of the current line's own parse — the identical
  // `parseQuickAdd`/`taskFieldsForRename` pipeline `commit` itself will
  // run, just read a render early so the footer can react to it (QA-16's
  // grow-on-recognition, PRI-04's pill) without waiting for Add to be
  // pressed. `taskFieldsForRename`, not `taskFieldsFromQuickAdd`: only it
  // distinguishes "no p[1-4] typed" (null) from "p4, typed" (1) — the
  // distinction PRI-04's pill needs to decide whether to render at all.
  const parsed = parseQuickAdd(composer.value, composer.options);
  const preview = taskFieldsForRename(composer.value, parsed, composer.options);
  const hasDate = preview.date !== null || preview.dateString !== null;
  const hasPriority = preview.priority !== null;
  const uiPriority = hasPriority ? uiPriorityOf(preview.priority as number) : null;

  function removeDate() {
    // `composer.remount` is what actually changes what's on screen —
    // `task-title-editor.tsx`'s own doc comment is explicit that a later
    // `value` prop change is never resynced into an already-mounted
    // document, so this rebuilds a fresh instance seeded with the
    // date-stripped text instead of trying to edit the live ProseMirror
    // doc from outside it.
    const stripped = stripDateTokens(composer.value, parsed.tokens);
    composer.remount(stripped);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          aria-label="Quick Add"
          data-testid="quick-add"
          className={DIALOG_CLASSES}
          onEscapeKeyDown={(event) => {
            // This file's own header comment has the full Radix-capture
            // ordering reasoning: preventing the dismissal here is what
            // lets the keystroke go on to close only the popup instead.
            if (autocompleteOpenRef.current) {
              event.preventDefault();
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">Quick Add</DialogPrimitive.Title>
          <Suspense fallback={<div className="h-8" />}>
            <LazyTaskTitleEditor
              key={composer.resetKey}
              value={composer.seed}
              ariaLabel="Task name"
              autoFocus={true}
              commitOnBlur={false}
              onChange={composer.setValue}
              onCommit={composer.commit}
              onCancel={() => onOpenChange(false)}
              className={EDITOR_BOX_CLASSES}
              extraPlugins={composer.extraPlugins}
              autocomplete={composer.autocomplete}
              onAutocompleteOpenChange={(isOpen) => {
                autocompleteOpenRef.current = isOpen;
              }}
            />
          </Suspense>

          {/* PRI-04: the flag icon alone carries the priority's colour —
              the `P{n}` text stays the shared neutral grey
              (`text-muted-foreground`, which is `rgb(204,204,204)` in dark
              theme, the exact value scheduler-and-priority.md §10b
              measured for the text). */}
          {hasPriority && uiPriority !== null && (
            <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="size-3.5"
                fill={priorityPickerColour(uiPriority)}
              >
                <path d="M2 1.5a.5.5 0 0 1 1 0V2h9.5a.5.5 0 0 1 .4.8L11 6l1.9 3.2a.5.5 0 0 1-.4.8H3v4.5a.5.5 0 0 1-1 0v-13Z" />
              </svg>
              <span>P{uiPriority}</span>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[color:var(--td-composer-border)] pt-3">
            <div className="flex items-center gap-2">
              {/* QA-18: `Tab` from the title field lands here first —
                  natural DOM order already gives that, since this is the
                  editor's very next focusable sibling. No menu is wired
                  behind it (out of scope for this ticket — the record
                  never established its contents, only that Tab reaches
                  it); reported as unimplemented rather than faked. */}
              <Button type="button" variant="ghost" size="sm" aria-label="More actions">
                <span aria-hidden="true">…</span>
              </Button>
              {hasDate && (
                <Button type="button" variant="ghost" size="sm" onClick={removeDate}>
                  Remove date
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
