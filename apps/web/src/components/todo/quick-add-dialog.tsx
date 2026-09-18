import { parseQuickAdd, uiPriorityOf } from "@meologue/core";
import { X } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
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

// 32px (`h-8`) — the content row the rest state's 66px chrome math needs
// (this file's own header comment). Same idiom `add-task-form.tsx`'s
// `EDITOR_BOX_CLASSES` already reaches for with its own `h-8`, not a
// number invented here.
const EDITOR_ROW_CLASSES = "flex h-8 items-center gap-2";

// 31px (`mt-1` 4 + `border-t` 1 + `pt-0.5` 2 + `h-6` "xs" buttons 24) —
// the exact footer sum the grown state's 97px chrome math needs (this
// file's own header comment does the arithmetic).
const FOOTER_CLASSES =
  "mt-1 flex items-center justify-between gap-2 border-t border-[color:var(--td-composer-border)] pt-0.5";

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
  // Issue #261 — this file's own header comment on the Escape/popup trap
  // has the full reasoning: `onEscapeKeyDown` below cannot trust the same
  // keydown to reach `quick-add-autocomplete.ts`'s own handler once it has
  // called `event.preventDefault()` itself, so it closes the popup
  // directly through this instead, the identical shape
  // `task-detail-view.tsx`'s `dismissGuardRef` already uses.
  const closeAutocompleteRef = useRef<(() => void) | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const composer = useQuickAddComposer({
    onAdd,
    projects,
    labels,
    onCreateProject,
    onCreateLabel,
    onCommitted: () => onOpenChange(false),
  });

  // Issue #265 follow-up — a live pass found the discard confirmation
  // itself firing on a genuinely empty reopened Quick Add. Root cause,
  // confirmed by reading `use-quick-add-composer.ts`: this dialog is
  // always mounted (`todo-page.tsx` renders `<QuickAddDialog open=
  // {quickAddOpen} .../>` unconditionally, only toggling `open`), so
  // `composer`'s own state outlives any single open/close cycle.
  // `composer.value` — the "live mirror" `onChange` updates on every
  // keystroke — is what `hasText` reads, but NOTHING resets it when a
  // dismissal ends the session without a commit: `commit`/`remount` are
  // the only two functions that ever touch it, and neither Discard nor
  // Cancel/Escape/an outside click/the X button call either. So after
  // type → Escape → Discard, `composer.value` still reads "buy milk" —
  // stale, not merely uncleared — even once Radix has torn the old
  // `LazyTaskTitleEditor` down and the next open mounts a genuinely fresh
  // one. (`composer.seed`, the OTHER piece `remount` also owns, is
  // usually fine on its own — plain typing never touches it — which is
  // why the reopened editor itself really was empty; the bug is a stale
  // mirror, not an unclear field. Except "Remove date" also calls
  // `remount(stripped)`, so a type → Remove date → Escape → Discard cycle
  // leaves `seed` stale too, the identical bug one layer deeper — this
  // fix covers that path as well.)
  //
  // The fix matches this repo's own precedent for exactly this bug class:
  // `task-time-dialog.tsx`'s and `task-custom-repeat-dialog.tsx`'s own
  // "re-seed the local draft on the open transition, never while already
  // open" `useEffect` (their own comments: "a dismiss never commits, so
  // the next open must reflect reality, not an abandoned draft"). Those
  // two re-seed FROM a prop (`time`/the Task's own repeat rule); Quick Add
  // has no such source of truth to re-seed from — its own "reality" is
  // simply blank — so this resets straight to `""`, reusing
  // `composer.remount` (the identical primitive `removeDate` below
  // already trusts) rather than resetting `value`/`seed`/`resetKey` by
  // hand here. This is deliberately unconditional (every open, not only
  // when something was actually left stale) and applies uniformly to
  // every dismissal route — Discard, Cancel, Escape, an outside click, the
  // X button all funnel through the identical `requestDismiss`/Radix
  // `onOpenChange` wiring below with no door-specific state to clean up,
  // so fixing the shared `composer` fixes every door at once rather than
  // patching `hasText` or any one handler.
  //
  // Also answers "does anything else the composer holds leak the same
  // way" (asked directly during review): no — `hasDate`/`hasPriority`/
  // `uiPriority`/`preview` below are all pure derivations of `composer.
  // value` via `parseQuickAdd`/`taskFieldsForRename`, recomputed fresh
  // every render, not separate stored state. Quick Add has no project/
  // label picker of its own yet (this file's own header comment: "a
  // different ticket's surface"), so `composer.value` was the only actual
  // piece of draft state to leak.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only on the open transition (`task-time-dialog.tsx`'s own biome-ignore, identical reason) — not on every `composer` identity change, which is a fresh object every render regardless.
  useEffect(() => {
    if (open) {
      composer.remount("");
    }
  }, [open]);

  const parsed = parseQuickAdd(composer.value, composer.options);
  const preview = taskFieldsForRename(composer.value, parsed, composer.options);
  const hasDate = preview.date !== null || preview.dateString !== null;
  const hasPriority = preview.priority !== null;
  const uiPriority = hasPriority ? uiPriorityOf(preview.priority as number) : null;
  // Issue #264: the one thing that decides 66px vs 97px. Trimmed so
  // whitespace-only input still reads as "empty" — the identical check
  // "Add task" already uses below to decide whether it's enabled.
  //
  // Issue #265 reuses this same check for the discard guard below, and it
  // is already safe against the trap this repo has been bitten by before
  // (a ProseMirror placeholder decoration making an empty editor read as
  // non-empty via `textContent`, `prosemirror-placeholder-fakes-nonempty`):
  // `composer.value` is set from `onChange`, which `task-title-editor.tsx`
  // feeds with `titleTextFromDoc(nextState.doc)` — the MODEL doc's own
  // `textContent`, not the DOM's. The placeholder ("Add task") is painted
  // by `placeholderPlugin` as a `Decoration.widget`, which lives outside
  // the document entirely (`task-title-editor.tsx`'s own `decorations`
  // prop, gated on `state.doc.content.size > 0` — the widget only renders
  // when the doc IS empty). So `doc.textContent`, and therefore
  // `composer.value`, never contains it: an empty field reads as `""`
  // here, not `"Add task"`. Verified by reading that source, not assumed.
  const hasText = composer.value.trim() !== "";

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const discardConfirmedRef = useRef(false);

  function requestDismiss() {
    if (hasText) {
      setDiscardConfirmOpen(true);
      return;
    }
    onOpenChange(false);
  }

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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Issue #265 — Radix only ever calls this with `false` (opening is
        // this component's own `open` prop, not something Root decides for
        // itself), for every dismissal it drives directly: Escape when the
        // autocomplete popup isn't open (`onEscapeKeyDown` below only
        // intercepts the popup-open case), an outside click (no
        // `onPointerDownOutside` override here — there is nothing else for
        // it to do), and the X button (`DialogClose` calls this
        // same `onOpenChange` under Radix's own hood). Routing all three
        // through `requestDismiss` is what makes them agree with the
        // editor's own Escape `onCancel` and the footer's Cancel button
        // below, rather than three doors independently deciding whether
        // there's something worth confirming.
        if (next) {
          onOpenChange(next);
          return;
        }
        requestDismiss();
      }}
    >
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogContent
          open={open}
          ref={contentRef}
          aria-label="Quick Add"
          data-testid="quick-add"
          className={DIALOG_CLASSES}
          onEscapeKeyDown={(event) => {
            // This file's own header comment has the full reasoning: the
            // `preventDefault()` below is what stops Radix dismissing the
            // dialog, but it ALSO gates `prosemirror-view`'s own key
            // handling for this same event — so the popup has to be
            // closed directly, through `closeAutocompleteRef`, rather than
            // trusted to close itself once this handler returns.
            if (autocompleteOpenRef.current) {
              event.preventDefault();
              closeAutocompleteRef.current?.();
            }
          }}
        >
          <DialogTitle className="sr-only">Quick Add</DialogTitle>
          <div className={EDITOR_ROW_CLASSES}>
            <div className="min-w-0 flex-1">
              <Suspense fallback={<div className="h-8" />}>
                <LazyTaskTitleEditor
                  key={composer.resetKey}
                  value={composer.seed}
                  ariaLabel="Task name"
                  autoFocus={true}
                  commitOnBlur={false}
                  onChange={composer.setValue}
                  onCommit={composer.commit}
                  // Issue #265 — this is the door Escape actually travels
                  // through whenever the autocomplete popup ISN'T open:
                  // `task-title-editor.tsx`'s own `commitKeymap` binds
                  // `Escape` to call this prop directly (its own doc
                  // comment on `onCancel`), and reaches Radix's document-
                  // capture Escape listener too on the same keystroke — both
                  // now agree, because both call `requestDismiss`.
                  onCancel={requestDismiss}
                  className={EDITOR_BOX_CLASSES}
                  extraPlugins={composer.extraPlugins}
                  autocomplete={composer.autocomplete}
                  onAutocompleteOpenChange={(isOpen) => {
                    autocompleteOpenRef.current = isOpen;
                  }}
                  closeAutocompleteRef={closeAutocompleteRef}
                />
              </Suspense>
            </div>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Close">
                <X aria-hidden="true" className="size-3.5" />
              </Button>
            </DialogClose>
          </div>

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

          {/* Issue #264: this whole toolbar row only exists once there's
              text — matching Todoist's own 66→97px grow-on-text (this
              file's own header comment has the exact arithmetic behind
              `FOOTER_CLASSES` and the "xs"-sized buttons below). At rest
              this block is absent entirely, not hidden, so it contributes
              nothing to the compact single-row layout above. */}
          {hasText && (
            <div className={FOOTER_CLASSES}>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="xs" aria-label="More actions">
                  <span aria-hidden="true">…</span>
                </Button>
                {hasDate && (
                  <Button type="button" variant="ghost" size="xs" onClick={removeDate}>
                    Remove date
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Issue #265 — this button only ever renders once `hasText`
                    is true (the `{hasText && (...)}` footer above), so every
                    real click here already has something worth confirming;
                    `requestDismiss` still gets the general check, rather
                    than this call site special-casing "always confirm",
                    so it stays the one door with the guard, not two. */}
                <Button type="button" variant="outline" size="xs" onClick={requestDismiss}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="xs"
                  onClick={() => composer.commit(composer.value)}
                  disabled={composer.value.trim() === ""}
                >
                  Add task
                </Button>
              </div>
            </div>
          )}

          <ConfirmDialog
            open={discardConfirmOpen}
            onOpenChange={setDiscardConfirmOpen}
            title="Discard unsaved changes?"
            description="Your unsaved changes will be discarded."
            confirmLabel="Discard"
            onConfirm={() => {
              discardConfirmedRef.current = true;
              onOpenChange(false);
            }}
            onCloseAutoFocus={(event) => {
              if (discardConfirmedRef.current) {
                discardConfirmedRef.current = false;
                return;
              }
              event.preventDefault();
              contentRef.current
                ?.querySelector<HTMLElement>('[contenteditable="true"]')
                ?.focus({ preventScroll: true });
            }}
          />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
