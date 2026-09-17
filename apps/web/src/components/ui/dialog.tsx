/**
 * Issue #342 — focus was not restored when a Dialog closed. Root cause
 * (verified in `@radix-ui/react-dialog@1.1.23`, `dist/index.mjs`, both
 * `DialogContentModal` — the `modal` path — and `DialogContentNonModal`
 * — the `modal={false}` path task-time-dialog.tsx/task-custom-repeat-
 * dialog.tsx both use): absent a caller-supplied `onCloseAutoFocus` that
 * itself calls `event.preventDefault()`, *both* paths install a default
 * that does exactly that — `event.preventDefault()`, then
 * `context.triggerRef.current?.focus()` — unconditionally, every close.
 *
 * `preventDefault()` is what breaks this: it suppresses `FocusScope`'s
 * own already-correct fallback (`@radix-ui/react-focus-scope`'s unmount
 * effect: `focus(previouslyFocusedElement ?? document.body)`, where
 * `previouslyFocusedElement` is `document.activeElement` captured at
 * mount — the right element, every time). `context.triggerRef` is
 * `Dialog`'s own ref, populated *only* by an actual `<Dialog.Trigger>` —
 * this app opens every dialog from a controlled `open` boolean instead
 * (grep the whole tree for `Dialog.Trigger`: the only two hits are
 * comments in `task-detail-view.tsx` describing this exact defect), so
 * that ref is always `null` and the "restore" is a no-op. Both halves of
 * Radix's default are dead on arrival here; the visible result is focus
 * left on `document.body`.
 *
 * Confirmed in jsdom (not merely read off the source) that the `modal=
 * {false}` path has the identical dead-on-arrival default as `modal`:
 * a probe against the production `TaskTimeDialog` component, mounted
 * standalone with no parent handler, landed on `document.body` after
 * Cancel. That is a narrower finding than "this surface is broken in the
 * app," and it is *not* a claim that this issue's own live-browser
 * pre-investigation notes are wrong — those recorded `BUTTON "Date"`
 * (the scheduler's own trigger) as the correctly-restored element for
 * both `TaskTimeDialog` and `TaskCustomRepeatDialog`, taken live against
 * the running app, which is the one instrument this issue trusts for
 * focus (a jsdom probe already produced one false-green result earlier
 * in this issue's own history: #339's mutation test passed with the fix
 * removed, because a `DropdownMenu`'s stray `setTimeout(0)` satisfied
 * the assertion for the wrong reason).
 *
 * The two readings describe different things, not a contradiction: my
 * probe mounts `TaskTimeDialog` in isolation, where nothing else can
 * restore focus once Radix's own default is dead. In the running app,
 * both dialogs are opened from inside `task-schedule-popover.tsx`'s own
 * `PopoverContent`, and *neither* dialog's own props expose an
 * `onCloseAutoFocus` slot for that popover to fill (`TaskTimeDialogProps`
 * /`TaskCustomRepeatDialogProps` — grepped, confirmed, neither has one) —
 * so whatever put focus back on `Date` live was never these dialogs' own
 * `onCloseAutoFocus` at all; some other mechanism this file does not
 * fully account for (most likely `PopoverContent`'s own resumed
 * `FocusScope`, or `Date` simply being what `document.activeElement`
 * already was at the moment each dialog's own `FocusScope` captured
 * `previouslyFocusedElement`) did it. This fix makes each dialog's own
 * `onCloseAutoFocus` restore to *that same captured element* instead of
 * running Radix's dead trigger-focus no-op — a strict improvement over
 * "does nothing" only if nothing else was already relying on that no-op
 * to leave focus alone for it to move in after. Flagged, not resolved:
 * the live-browser agent that verifies this branch should specifically
 * re-check `TaskTimeDialog`/`TaskCustomRepeatDialog` against `Date`
 * still landing correctly, since this is the one place this fix could
 * regress a surface the issue's own investigation found already
 * correct.
 *
 * **The fix, and how a new Dialog is kept from opting out of it.** This
 * module is the one place in the app allowed to `import { Dialog } from
 * "radix-ui"` — `biome.json`'s `noRestrictedImports` bans that import
 * everywhere else (its own `overrides` entry excepts this file), so a
 * dialog built by reaching for `radix-ui` directly, the way every dialog
 * in this app did before this issue, fails `biome check` instead of
 * silently reproducing the bug. That is enforcement of *routing through
 * this module*, verified by a real lint rule this repo's own gates run
 * — it is not the closed, structural, "every case must be listed"
 * enforcement `StoreMethodNames` gets from TypeScript
 * (`defer-store.ts`'s own header comment): nothing stops a determined
 * caller from disabling the lint rule inline, and Dialog surfaces are an
 * open set, not an enumerable one the compiler can check for
 * completeness. It is a strong, gate-checked default, not a type-level
 * guarantee — said plainly rather than oversold.
 *
 * `DialogContent` (not Radix's own `Dialog.Content`) is the second half:
 * it requires `open` as a prop — not read from Radix's own private
 * context — because it has to capture `document.activeElement` in a
 * `useLayoutEffect` timed to run *before* `FocusScope`'s own mount-
 * autofocus effect (a passive `useEffect`, always later in the same
 * commit — React flushes every layout effect in a commit before any
 * passive effect, regardless of parent/child order) steals focus into
 * the Content. On close, its own `onCloseAutoFocus` calls
 * `preventDefault()` itself (so Radix's own dead-on-arrival default
 * never runs) and restores focus to whatever it captured — composing
 * with, never overriding, a caller's own `onCloseAutoFocus`: the
 * caller's handler always runs first, and this wrapper's own restore is
 * skipped entirely once that handler calls `preventDefault()`, the
 * identical composition rule Radix's own defaults already use. That is
 * what keeps a deliberate override (`task-detail-view.tsx`'s discard-
 * confirm `ConfirmDialog`, `TaskActivityDialog` below via
 * `restoreFocusTo`) working unchanged.
 *
 * `restoreFocusTo` is the second, narrower override: for a dialog opened
 * from something that is *itself* gone the instant this dialog opens
 * (`TaskActivityDialog`'s own header comment — the `DropdownMenu.Item` a
 * reader clicked unmounts with the overflow menu, before this dialog's
 * open animation even starts), the generically-captured "previously
 * focused element" is the wrong target even though it's real and
 * connected. A caller that knows a better, stable anchor names it here;
 * this wrapper still supplies the gone-at-close fallback that hand-
 * written `onCloseAutoFocus` callbacks in this codebase never did.
 *
 * **Revision, after live-browser verification of the first version of this
 * file found a real regression.** That version, lacking any good target,
 * forced focus onto `#root` (`index.html`'s mount point, made focusable
 * with `tabIndex=-1`) rather than leaving it on `document.body`. For
 * `TaskTimeDialog`'s own Escape path this *broke* a surface the issue's
 * own investigation had found correct: Escape closes both the Time
 * dialog and the scheduler popover underneath it (issue #326's own
 * simultaneous-close mechanism), so the previously-focused element this
 * wrapper captured (something inside the popover) is disconnected by the
 * time this dispatch runs — but the popover's own `FocusScope`, tearing
 * down moments later with a real `PopoverTrigger` (`BUTTON "Date"`, this
 * app's one legitimate `*.Trigger` usage — `task-schedule-popover.tsx`),
 * was *already* going to restore focus there correctly, exactly as it
 * does on `main`. `#root` is a real, focusable DOM node — calling
 * `.focus()` on it is an active, observable act that lands *after* the
 * popover's own restore and overwrites it. `document.body` has no
 * `tabIndex`; calling `.focus()` on it (which is what a captured-but-
 * meaningless "previously focused" value used to fall through to, see
 * below) is normally a no-op that changes nothing — which is why the
 * sibling `TaskCustomRepeatDialog` Escape path, sharing the identical
 * wrapper and the identical simultaneous-close mechanism, never
 * regressed: what it had captured at open time was already
 * `document.body` (its own opener is a two-step `DropdownMenu`
 * hand-off — issues #255/#292's own pattern — whose own
 * `onCloseAutoFocus` deliberately focuses nothing before this dialog
 * mounts), and restoring to `document.body` never competed with the
 * popover's later restore the way actually-focusing `#root` did.
 *
 * So: **this wrapper does not force a target it doesn't have a real one
 * for.** No `restoreFocusTo`, and no captured element that is both still
 * connected AND is not `document.body` (`isConnectedFocusable` rejects
 * `body` outright, wherever a value is read from, rather than only
 * skipping it case-by-case at the restore site — `document.body` is
 * always `.isConnected` and always has a `.focus` method, so without
 * this exclusion it reads as a perfectly "good" target, which is exactly
 * how the `TaskCustomRepeatDialog` Cancel/outside-click paths ended up
 * faithfully restoring to `body` instead of standing aside: they had
 * genuinely captured "nothing was focused," and nothing before this
 * revision treated that capture as equivalent to no capture at all).
 * With no good target: this calls neither `preventDefault()` nor
 * `.focus()` at all, deferring entirely to whatever Radix's own dead
 * default and any surrounding `FocusScope` (a still-open Popover, or one
 * closing at the same moment with its own real restore) would have done
 * with this wrapper out of the way. That is *not* the same as "restores
 * to `document.body`" even on a surface with nothing better available
 * (the Shortcuts overlay, Label edit, Project edit): this wrapper made
 * no choice there at all, and the value the page ends up showing is
 * whatever the rest of the page's own focus story already determines —
 * unfixed, in those three cases, matching `main`'s own long-standing
 * `BODY` result, but never *regressed* by an active claim this wrapper
 * had no business making. A real fix for those three needs a
 * `restoreFocusTo` naming a stable anchor, the same way `TaskActivityDialog`
 * below does — left to a follow-up rather than guessed at here.
 */
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";

export const Dialog = DialogPrimitive.Root;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogOverlay = DialogPrimitive.Overlay;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

type NativeDialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>;

export interface DialogContentProps extends NativeDialogContentProps {
  /**
   * Required, not optional: see this file's header comment for why a
   * dialog built through this wrapper cannot compile without wiring the
   * one thing the wrapper exists to guarantee.
   */
  open: boolean;
  /**
   * Restore focus here on close instead of to whatever was focused
   * before this dialog opened. For a dialog whose real opener won't
   * survive to be focused again (this file's header comment,
   * `TaskActivityDialog` below) — not for the ordinary case, which needs
   * nothing here at all.
   */
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
}

// `document.body` is excluded on purpose, not just an incidental filter:
// it is always `.isConnected` and always has a `.focus` method, so
// without this it reads as a perfectly "good" target — which is exactly
// how a dialog that captured "nothing was focused" (this file's header
// comment: `TaskCustomRepeatDialog`'s two-step `DropdownMenu` hand-off)
// ended up faithfully restoring focus to `body` instead of standing
// aside. Treating it as capturing nothing is what makes standing aside
// possible at all.
//
// Mutation-tested (`dialog.test.tsx`) by removing the `!== document.body`
// clause: the mutant survived. Investigated, not shrugged off: calling
// `document.body.focus()` is a browser (and jsdom) no-op — body has no
// `tabIndex`, so `.focus()` on it never actually changes
// `document.activeElement` — meaning "wrongly treat body as good, call
// `.focus()` on it, achieve nothing" and "correctly reject body, stand
// aside, achieve nothing" are observationally identical outcomes. Kept
// anyway: `event.preventDefault()` is only called in the "good target"
// branch, so this clause is what keeps this wrapper from claiming
// (falsely) to have handled a close it did nothing useful with.
function isConnectedFocusable(element: HTMLElement | null): element is HTMLElement {
  return (
    Boolean(element?.isConnected) &&
    typeof element?.focus === "function" &&
    element !== document.body
  );
}

export const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  function DialogContent(
    { open, restoreFocusTo, onCloseAutoFocus, ...contentProps },
    forwardedRef,
  ) {
    const previouslyFocusedRef = React.useRef<HTMLElement | null>(null);
    const wasOpenRef = React.useRef(false);

    // `useLayoutEffect`, not `useEffect`: see this file's header comment
    // on why the ordering has to beat `FocusScope`'s own mount-autofocus
    // effect rather than just running "on open". Mutation-tested
    // (`dialog.test.tsx`) by swapping this back to `useEffect`: the
    // mutant survived — `@radix-ui/react-focus-scope`'s own container is
    // populated through `useState` (a ref callback calling `setContainer`),
    // so its mount-autofocus effect only ever runs a commit *after* this
    // one, keeping even a plain `useEffect` here ahead of it against the
    // installed version. Kept as `useLayoutEffect` anyway — a same-commit
    // container would silently reopen the race this guards against, and
    // there is no compiler check standing behind "FocusScope will always
    // need two commits."
    React.useLayoutEffect(() => {
      if (open && !wasOpenRef.current) {
        previouslyFocusedRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      wasOpenRef.current = open;
    }, [open]);

    const handleCloseAutoFocus = React.useCallback(
      (event: Event) => {
        // The caller's own handler always runs first, and can compose
        // exactly like Radix's own defaults do: call `preventDefault()`
        // to keep the rest of this from running at all (`task-detail-
        // view.tsx`'s discard-confirm `ConfirmDialog`), or leave it
        // uncalled to fall through to the restore below.
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;

        const explicitTarget = restoreFocusTo?.current ?? null;
        if (isConnectedFocusable(explicitTarget)) {
          event.preventDefault();
          explicitTarget.focus({ preventScroll: true });
          return;
        }

        const capturedTarget = previouslyFocusedRef.current;
        if (isConnectedFocusable(capturedTarget)) {
          event.preventDefault();
          capturedTarget.focus({ preventScroll: true });
          return;
        }

        // No good target: stand aside entirely (this file's header
        // comment has the full story of why forcing one — the previous
        // version of this file forced `#root` — is worse than doing
        // nothing). Neither `preventDefault()` nor `.focus()` is called;
        // Radix's own dead default and any surrounding `FocusScope` (a
        // Popover that stays open, or one closing at the same moment
        // with a real trigger of its own) get to do whatever they would
        // have done with this wrapper out of the way.
      },
      [onCloseAutoFocus, restoreFocusTo],
    );

    return (
      <DialogPrimitive.Content
        {...contentProps}
        ref={forwardedRef}
        onCloseAutoFocus={handleCloseAutoFocus}
      />
    );
  },
);
