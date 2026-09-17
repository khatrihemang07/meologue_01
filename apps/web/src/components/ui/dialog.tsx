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
 * Never `document.body`. If neither `restoreFocusTo` nor the captured
 * element is still connected and focusable, this focuses `#root` (`
 * index.html`'s own React mount point, always present) instead — kept
 * inside the app's live region rather than the document frame. Not a
 * fully semantic target (it's not "the Inbox link" or any other reader-
 * meaningful place), but a strictly better default than `body`, and
 * `main.tsx` never sets `tabIndex` on it — hasAttribute is checked first
 * so this only ever touches that once per session.
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

function isConnectedFocusable(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.isConnected) && typeof element?.focus === "function";
}

// Never `document.body` (this file's header comment) — `#root` is
// `index.html`'s own React mount point (`main.tsx`'s `getElementById
// ("root")`), always present for the app's whole lifetime, so this never
// has to further fall back to nothing.
function focusAppRoot() {
  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement)) return;
  if (!root.hasAttribute("tabindex")) {
    root.setAttribute("tabindex", "-1");
  }
  root.focus({ preventScroll: true });
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
        event.preventDefault();

        const explicitTarget = restoreFocusTo?.current ?? null;
        if (isConnectedFocusable(explicitTarget)) {
          explicitTarget.focus({ preventScroll: true });
          return;
        }

        const capturedTarget = previouslyFocusedRef.current;
        if (isConnectedFocusable(capturedTarget)) {
          capturedTarget.focus({ preventScroll: true });
          return;
        }

        focusAppRoot();
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
