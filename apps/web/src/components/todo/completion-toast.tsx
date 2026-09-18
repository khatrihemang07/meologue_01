import { Button } from "@/components/ui/button";

/**
 * CMT-04 (parity ledger) — the body of the Task-completion Undo toast
 * (`raiseCompletionToast`, todo-page.tsx), raised through `toast.custom()`
 * (`use-completion-toast.tsx`) rather than the plain `toast(message, {...})`
 * every other toast in this app uses, so an Undo button can sit beside the
 * message.
 *
 * Issue #357 deleted this component's own `role="alert"`/`aria-live`
 * wrapper and the stylesheet it hand-copied from sonner's own injected
 * CSS to look native under `data-styled="false"` (sonner's own rendering
 * path for `toast.custom()` content) — sonner 2.0.8 had no `role`/
 * `aria-live` option on any of its types, so this was the only way to get
 * one. `components/ui/toast.tsx`'s `Toaster` now renders every toast,
 * including this one, inside the identical card chrome (padding, border,
 * background, radius, shadow) every other toast gets, and Radix's
 * `Toast.Root` announces itself to a screen reader on its own — there is
 * nothing left for this component to hand-build. What is left is exactly
 * the two things unique to this toast: the message and the Undo button.
 */
export function CompletionToastBody({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <>
      <div className="min-w-0 flex-1 font-medium">{message}</div>
      <Button type="button" size="xs" onClick={onUndo}>
        Undo
      </Button>
    </>
  );
}
