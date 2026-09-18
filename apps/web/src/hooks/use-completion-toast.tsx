import { useRef } from "react";
import { toast } from "sonner";
import { CompletionToastBody } from "@/components/todo/completion-toast";
import { COMPLETION_TOAST_DURATION_MS } from "@/platform/completion-toast-duration";

/**
 * CMT-05 (parity ledger) — how long a completion toast stays up. This used
 * to be a single hard-coded constant here; issue #356 moved it behind the
 * build-time platform seam (`@/platform/completion-toast-duration`,
 * ADR 0005) because Todoist web's and Todoist Android's own undo windows
 * are a measured 3x apart, so one figure is wrong for at least one
 * meologue target. See that seam's per-target files for the measurements
 * and their provenance — `completion-toast-duration.web.ts` (web, macOS
 * and sandbox: 10s) and `completion-toast-duration.android.ts` (Android:
 * ~3.5s). Under vitest (mode "test", outside the seam's target list) this
 * resolves to the web file, so existing tests asserting `duration: 10_000`
 * are exercising the same fallback the seam gives an unqualified
 * `vite build`.
 *
 * Issue #355 moved this out of `todo-page.tsx` (where it was first
 * measured, as that file's own `COMPLETION_TOAST_DURATION_MS`) into this
 * shared module: the Composer's Task overlay raises the identical
 * completion toast now (`useCompletionToast` below), and a duration
 * measured once for the action, not for the page, has exactly one home to
 * live in.
 */

export interface CompletionToastControls {
  /**
   * Raises a completion Undo toast for `message`, calling `onUndo` if
   * Undo is used — through the toast's own button (`completion-toast.tsx`)
   * or the `Z`/`⌘Z` binding (`fireUndo` below, `useCompletionUndoShortcut`'s
   * own door onto it).
   *
   * Issue #355: dismisses whichever completion toast this same hook
   * instance still has open first, so a second completion made before the
   * first toast's own 10s expires replaces it rather than stacking beside
   * it. Before this, an un-dismissed older toast stayed reachable by its
   * own click-Undo button alone — `pendingUndoRef` below only ever tracks
   * the newest, so the keyboard binding could never reach it once a second
   * completion landed.
   */
  raise: (message: string, onUndo: () => void) => void;
  /**
   * CMT-05's one door onto `pendingUndoRef` below — `todo-page.tsx`'s
   * `useTodoKeymap` `onUndoComplete` option and `composer-page.tsx`'s own
   * `useCompletionUndoShortcut` (below) both call this and nothing else,
   * so `Z`/`⌘Z` always resolves to whichever toast this hook instance is
   * currently showing, on either surface.
   */
  fireUndo: () => void;
}

/**
 * The one completion-toast implementation for the app (issue #355) —
 * `todo-page.tsx` and `composer-page.tsx` both call this rather than each
 * keeping its own `toast.custom()`/`pendingUndoRef` pair, which is how the
 * two drifted apart before: different durations, only one of them
 * announcing to a screen reader, only one of them reachable by keyboard
 * undo, and only one of them replacing a still-open toast instead of
 * stacking beside it.
 */
export function useCompletionToast(): CompletionToastControls {
  // CMT-05 (parity ledger) — the one thing `Z`/`⌘Z` has to act on: the
  // most recent completion's own `undo`, live only while its toast is
  // still showing. A `ref`, not `useState`, deliberately — this never
  // drives a render, only `fireUndo`'s later, out-of-band read of it, the
  // same reason `document.activeElement` (`focusedTaskId()`,
  // todo-keymap.ts) is read fresh rather than tracked in state. `toastId`
  // guards against a stale write: if a second completion happens before
  // the first toast's `onAutoClose`/`onDismiss` fires, that older
  // callback must not clear the ref out from under the newer completion
  // it no longer describes.
  const pendingUndoRef = useRef<{ toastId: string | number; undo: () => void } | null>(null);

  function raise(message: string, onUndo: () => void) {
    // Issue #355: replace, don't stack — a still-open toast from an
    // earlier completion is dismissed before this one is raised, so
    // exactly one is ever on screen and `pendingUndoRef` (about to be
    // overwritten below) never orphans a toast the keyboard could no
    // longer reach anyway.
    if (pendingUndoRef.current !== null) {
      toast.dismiss(pendingUndoRef.current.toastId);
      pendingUndoRef.current = null;
    }

    const undo = () => {
      onUndo();
      pendingUndoRef.current = null;
    };
    // sonner offers two different "it's gone" callbacks — the timer
    // (`onAutoClose`) and every other removal path, including our own
    // dismiss-the-old-one-first call above (`onDismiss`) — and this toast
    // clears the same ref through either one, so one function answers
    // both rather than two copies of the identical guard.
    const clearIfStillPending = () => {
      if (pendingUndoRef.current?.toastId === toastId) {
        pendingUndoRef.current = null;
      }
    };
    const toastId = toast.custom(
      (id) => (
        <CompletionToastBody
          message={message}
          onUndo={() => {
            undo();
            toast.dismiss(id);
          }}
        />
      ),
      {
        duration: COMPLETION_TOAST_DURATION_MS,
        onAutoClose: clearIfStillPending,
        onDismiss: clearIfStillPending,
      },
    );
    pendingUndoRef.current = { toastId, undo };
  }

  function fireUndo() {
    pendingUndoRef.current?.undo();
  }

  return { raise, fireUndo };
}
