import type { Section } from "@meologue/core";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { touchOnlyDevice } from "@/lib/pointer";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { useQuickAddComposer } from "@/lib/use-quick-add-composer";
import { QuickAddContent } from "./quick-add-content";
import { QuickAddInlineCard } from "./quick-add-inline-card";
import { QuickAddSheet } from "./quick-add-sheet";

export interface QuickAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (fields: QuickAddTaskFields) => void;
  projects?: readonly AutocompleteEntry[];
  labels?: readonly AutocompleteEntry[];
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
  datesWithTasks?: ReadonlyMap<string, number>;
  ambientProjectName?: string;
  /** Issue #388 — see `add-task-form.tsx`'s identically-named prop for the full reasoning; both surfaces share the same seam. */
  sectionNamesByProject?: ReadonlyMap<string, readonly string[]>;
  /** Issue #388's remaining half — see `add-task-form.tsx`'s identically-named prop. */
  listSections?: (projectId: string) => Promise<readonly Section[]>;
  /** Issue #388's remaining half — see `add-task-form.tsx`'s identically-named prop. */
  onCreateSection?: (projectId: string, name: string) => void;
}

/**
 * Todoist's own global "Quick Add" (Surface A, `web/01-anatomy.md`) /
 * Android's FAB sheet (`android/02-anatomy.md`) — issue #374's own shell
 * chosen by `touchOnlyDevice()` (#365), never by viewport width (D4).
 * This file keeps every piece of it that isn't the editor/toolbar/chips
 * themselves (now `QuickAddContent`, shared with `add-task-form.tsx`):
 * the discard-confirmation guard, the Escape-vs-autocomplete-popup trap,
 * and the reset-on-open effect. The shell itself — `QuickAddInlineCard`
 * (non-touch) or `QuickAddSheet` (touch) — supplies the chrome; this file
 * only decides which one and what dismissing it means.
 */
export function QuickAddDialog({
  open,
  onOpenChange,
  onAdd,
  projects = [],
  labels = [],
  onCreateProject,
  onCreateLabel,
  datesWithTasks,
  ambientProjectName,
  sectionNamesByProject,
  listSections,
  onCreateSection,
}: QuickAddDialogProps) {
  const touch = touchOnlyDevice();

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

  // Issue #374/D4: touch stays open after a real Add — the keyboard up,
  // the title cleared, chips reset to Inbox/Date (all three already fall
  // out of `composer.commit` clearing `value`/`seed`/bumping `resetKey`,
  // since the chips are pure derivations of the parsed, now-empty text),
  // project not remembered. `handleAdd`/`todo-page.tsx` raises the
  // "Added to…" toast itself, once it knows the actually-resolved
  // project — this file has no reason to duplicate that resolution.
  // Non-touch closes, exactly as before.
  const composer = useQuickAddComposer({
    onAdd,
    projects,
    labels,
    onCreateProject,
    onCreateLabel,
    open,
    // Issue #388 — the identical `touch ? "Inbox" : ambientProjectName`
    // resolution `content` below already applies for the chip's own
    // display text.
    ambientProjectName: touch ? "Inbox" : ambientProjectName,
    sectionNamesByProject,
    listSections,
    onCreateSection,
    onCommitted: () => {
      if (!touch) {
        onOpenChange(false);
      }
    },
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
  // stale, not merely uncleared — even once the old editor has been torn
  // down and the next open mounts a genuinely fresh one.
  //
  // The fix matches this repo's own precedent for exactly this bug class:
  // `task-time-dialog.tsx`'s and `task-custom-repeat-dialog.tsx`'s own
  // "re-seed the local draft on the open transition, never while already
  // open" `useEffect`. This resets straight to `""`, reusing
  // `composer.remount` (the identical primitive "Remove date" already
  // trusts) rather than resetting `value`/`seed`/`resetKey` by hand here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only on the open transition (`task-time-dialog.tsx`'s own biome-ignore, identical reason) — not on every `composer` identity change, which is a fresh object every render regardless.
  useEffect(() => {
    if (open) {
      composer.remount("");
      composer.setDescription("");
      composer.setDescriptionOpen(false);
      // Issue #373's own version of the identical #265 leak this effect
      // already exists to close: a multi-line paste dialog left pending
      // (dismissed some other way than its own Cancel/confirm, however
      // unlikely given it's modal) must not reappear the next time this
      // dialog opens.
      composer.cancelPendingPaste();
    }
  }, [open]);

  // Issue #264: the one thing that decides whether there's anything to
  // discard. Trimmed so whitespace-only input still reads as "empty" —
  // `composer.value` is the model doc's own `textContent`
  // (`task-title-editor.tsx`'s `titleTextFromDoc`), never the DOM's, so
  // the placeholder decoration can never fake this into "non-empty"
  // (`prosemirror-placeholder-fakes-nonempty`).
  const hasText = composer.value.trim() !== "" || composer.description.trim() !== "";

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const discardConfirmedRef = useRef(false);

  function requestDismiss() {
    if (hasText) {
      setDiscardConfirmOpen(true);
      return;
    }
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean) {
    // Radix only ever calls this with `false` (opening is this
    // component's own `open` prop, not something Root decides for
    // itself), for every dismissal it drives directly: Escape when the
    // autocomplete popup isn't open (`onEscapeKeyDown` below only
    // intercepts the popup-open case), an outside click, and the sheet's
    // own dismiss routes. Routing all of them through `requestDismiss` is
    // what makes them agree with the editor's own Escape `onCancel` and
    // the footer's Cancel button, rather than independently deciding
    // whether there's something worth confirming.
    if (next) {
      onOpenChange(next);
      return;
    }
    requestDismiss();
  }

  function handleEscapeKeyDown(event: KeyboardEvent) {
    // This file's own header comment has the full reasoning: the
    // `preventDefault()` below is what stops the shell dismissing the
    // dialog, but it ALSO gates `prosemirror-view`'s own key handling for
    // this same event — so the popup has to be closed directly, through
    // `closeAutocompleteRef`, rather than trusted to close itself once
    // this handler returns.
    if (autocompleteOpenRef.current) {
      event.preventDefault();
      closeAutocompleteRef.current?.();
    }
  }

  const content = (
    <QuickAddContent
      composer={composer}
      touch={touch}
      placeholder={composer.placeholder}
      datesWithTasks={datesWithTasks}
      ambientProjectName={touch ? "Inbox" : ambientProjectName}
      onCancel={requestDismiss}
      onAutocompleteOpenChange={(isOpen) => {
        autocompleteOpenRef.current = isOpen;
      }}
      closeAutocompleteRef={closeAutocompleteRef}
    />
  );

  return (
    <>
      {touch ? (
        <QuickAddSheet
          open={open}
          onOpenChange={handleOpenChange}
          ariaLabel="Quick Add"
          testId="quick-add"
          onEscapeKeyDown={handleEscapeKeyDown}
          contentRef={contentRef}
        >
          {content}
        </QuickAddSheet>
      ) : (
        // No `DialogOverlay` — Surface A carries `role="dialog"` but is
        // measured `position: static`, no backdrop at all
        // (`web/01-anatomy.md`). `DialogContent` is left unstyled (just
        // enough to host the Radix primitive correctly); `QuickAddInlineCard`
        // underneath is the actual visible card.
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent
            open={open}
            ref={contentRef}
            aria-label="Quick Add"
            data-testid="quick-add"
            className="static outline-hidden"
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            <DialogTitle className="sr-only">Quick Add</DialogTitle>
            <QuickAddInlineCard>{content}</QuickAddInlineCard>
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        title={touch ? "Discard changes?" : "Discard unsaved changes?"}
        description={
          touch
            ? "The changes you've made will not be saved."
            : "Your unsaved changes will be discarded."
        }
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
    </>
  );
}
