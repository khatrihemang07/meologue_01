/**
 * Issue #357 — replaces `sonner` with Radix's `Toast` primitive, behind the
 * identical imperative API sonner exposed (`toast(...)`, `.success`,
 * `.error`, `.custom`, `.dismiss`), so every call site changes an import
 * rather than a call. This file is both halves: the module-level queue
 * `toast(...)` writes into (sonner's own `toast` is a singleton store too,
 * reachable from outside React — `register-service-worker.web.ts` calls it
 * from a plain callback with no component above it), and the `Toaster`
 * component that reads that queue and renders it through Radix.
 *
 * Why sonner had to go (issue #357's own brief): sonner 2.0.8 exposes no
 * `role`/`aria-live` field on any of its option types, and its rendered
 * `<li data-sonner-toast>` hardcodes its own props with no spread — there
 * was no way to put an ARIA live region on a sonner toast except
 * `toast.custom()`'s escape hatch, which is why `completion-toast.tsx` used
 * to hand-build its own `role="alert"` body and hand-copy sonner's own
 * injected stylesheet to look native (deleted along with that file's own
 * warning comment). Radix's `Toast.Root` announces itself through a
 * visually-hidden live region it renders itself (`@radix-ui/react-toast`'s
 * own `ToastAnnounce`, `aria-live="assertive"` for the default
 * `type="foreground"`), so every toast below carries that natively — there
 * is nothing left to hand-build.
 *
 * What sonner gave for free that this file reimplements by hand:
 * - The queue itself: sonner already tracked "what's currently showing" in
 *   its own internal store; Radix's primitives are headless and controlled
 *   — nothing renders unless something outside them tracks open toasts and
 *   maps them to `<Toast.Root>` elements. `toasts`/`listeners` below are
 *   that store, read into React via `useSyncExternalStore`.
 * - A visible-toast cap: sonner defaults to 3 visible at once and queues
 *   the rest invisibly until room frees up. Nothing in this app has ever
 *   raised more than two toasts at a time (issue #355's own replace-not-
 *   stack rule keeps the completion toast to one), so `MAX_VISIBLE_TOASTS`
 *   below reimplements only the cap, not sonner's own "hold the overflow
 *   and reveal it later" queueing: past the cap, the oldest toast is
 *   dropped outright (its `onDismiss` still fires) rather than held back.
 * - Ordering: appending to the end of `toasts` and rendering top-to-bottom
 *   inside a viewport anchored by its own `bottom` offset reproduces
 *   sonner's own "newest nearest the anchored edge" stacking without
 *   sonner's own lift/scale animation for toasts further from the front.
 * - The auto-close/dismiss distinction `use-completion-toast.tsx` reads
 *   (`onAutoClose`/`onDismiss`): Radix funnels every non-explicit close —
 *   the duration timer elapsing, Escape, a swipe — through the same
 *   `onOpenChange(false)`, with no way to tell them apart from outside.
 *   `removeToast` below treats any of those as "auto" and an explicit
 *   `toast.dismiss(id)` call as "dismiss." The one caller that sets both
 *   (`use-completion-toast.tsx`) points them at the identical handler, so
 *   this distinction has never actually been load-bearing here — it is
 *   kept only because the sonner-shaped API promises both fields exist.
 *
 * What this drops rather than reimplements: sonner's own slide/lift exit
 * animation for a toast leaving the stack. A dismissed or expired toast
 * unmounts immediately here instead of animating out — Radix supports
 * animating on `data-state="closed"` before unmount, but nothing in this
 * app's test suite or its acceptance criteria (issue #357) depends on that
 * polish, and adding the extra open/closed-then-unmount bookkeeping for it
 * was not worth the complexity this ticket needed to add anyway.
 */

import { Toast as ToastPrimitive } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ToastId = string | number;

export interface ToastAction {
  label: React.ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
  onAutoClose?: () => void;
  onDismiss?: () => void;
}

/** sonner's own exported `Action` type name, kept so `import type { Action } from "sonner"` becomes an import-only change. */
export type Action = ToastAction;

type ToastVariant = "default" | "success" | "error" | "custom";

interface ToastRecord {
  id: ToastId;
  variant: ToastVariant;
  message?: React.ReactNode;
  render?: (id: ToastId) => React.ReactNode;
  duration: number;
  action?: ToastAction;
  onAutoClose?: () => void;
  onDismiss?: () => void;
}

// sonner's own unconfigured default (`TOAST_LIFETIME`, sonner/dist/index.mjs)
// — kept identical so every call site that never passed its own `duration`
// (history.tsx's copy/export toasts, task-tree.tsx's reparent-refused
// toast, and others) keeps the same time on screen it always had.
const DEFAULT_DURATION_MS = 4_000;

// sonner's own default `visibleToasts` — see this file's own header
// comment for what "cap" means here versus sonner's own queueing.
const MAX_VISIBLE_TOASTS = 3;

let toasts: ToastRecord[] = [];
let idCounter = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ToastRecord[] {
  return toasts;
}

function removeToast(id: ToastId, reason: "auto" | "dismiss") {
  const record = toasts.find((t) => t.id === id);
  if (!record) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
  if (reason === "auto") {
    record.onAutoClose?.();
  } else {
    record.onDismiss?.();
  }
}

function pushToast(record: ToastRecord) {
  toasts = [...toasts, record];
  while (toasts.length > MAX_VISIBLE_TOASTS) {
    const oldest = toasts[0];
    toasts = toasts.slice(1);
    oldest?.onDismiss?.();
  }
  emit();
}

function raise(
  variant: "default" | "success" | "error",
  message: React.ReactNode,
  options?: ToastOptions,
): ToastId {
  const id = idCounter++;
  pushToast({
    id,
    variant,
    message,
    duration: options?.duration ?? DEFAULT_DURATION_MS,
    action: options?.action,
    onAutoClose: options?.onAutoClose,
    onDismiss: options?.onDismiss,
  });
  return id;
}

export interface Toast {
  (message: React.ReactNode, options?: ToastOptions): ToastId;
  success: (message: React.ReactNode, options?: ToastOptions) => ToastId;
  error: (message: React.ReactNode, options?: ToastOptions) => ToastId;
  custom: (render: (id: ToastId) => React.ReactNode, options?: ToastOptions) => ToastId;
  dismiss: (id?: ToastId) => void;
}

const toastFn = ((message: React.ReactNode, options?: ToastOptions) =>
  raise("default", message, options)) as Toast;

toastFn.success = (message, options) => raise("success", message, options);
toastFn.error = (message, options) => raise("error", message, options);
toastFn.custom = (render, options) => {
  const id = idCounter++;
  pushToast({
    id,
    variant: "custom",
    render,
    duration: options?.duration ?? DEFAULT_DURATION_MS,
    onAutoClose: options?.onAutoClose,
    onDismiss: options?.onDismiss,
  });
  return id;
};
toastFn.dismiss = (id) => {
  if (id === undefined) {
    for (const record of toasts) removeToast(record.id, "dismiss");
    return;
  }
  removeToast(id, "dismiss");
};

/** The sonner-shaped API every call site in this app imports instead of `sonner`'s own `toast`. */
export const toast: Toast = toastFn;

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "fixed left-1/2 z-[100] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 flex-col gap-2 outline-none sm:right-4 sm:left-auto sm:translate-x-0",
        className,
      )}
      // Issue #355's own offset, preserved verbatim: `6rem` clears both
      // Todo's docked nav bar and the Composer's own docked bar, with
      // `--safe-bottom` (index.css) added on top for the device's home-
      // indicator inset. sonner's own `offset` prop did this same
      // arithmetic; a plain `bottom` style does it just as well now that
      // nothing else about the viewport's own positioning is sonner's.
      style={{ bottom: "calc(6rem + var(--safe-bottom))" }}
      {...props}
    />
  );
}

const TOAST_CARD_CLASS =
  "pointer-events-auto flex w-full items-center gap-3 rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg data-[swipe=move]:transition-none data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:slide-in-from-bottom-2";

function ToastCard({ record }: { record: ToastRecord }) {
  return (
    <ToastPrimitive.Root
      duration={record.duration}
      className={cn(TOAST_CARD_CLASS, record.variant === "error" && "border-destructive/40")}
      onOpenChange={(open) => {
        if (!open) removeToast(record.id, "auto");
      }}
    >
      {record.variant === "custom" ? (
        record.render?.(record.id)
      ) : (
        <>
          <div className="min-w-0 flex-1 font-medium">{record.message}</div>
          {record.action && (
            <ToastPrimitive.Action asChild altText={String(record.action.label)}>
              <Button type="button" size="xs" onClick={record.action.onClick}>
                {record.action.label}
              </Button>
            </ToastPrimitive.Action>
          )}
        </>
      )}
    </ToastPrimitive.Root>
  );
}

/**
 * Mounted once (`App.tsx`), exactly as sonner's own `<Toaster />` was.
 * `useSyncExternalStore` is what lets `toast(...)` be called from anywhere
 * — a plain callback with no component above it
 * (`register-service-worker.web.ts`), a store action, a keyboard handler —
 * and still reach whichever `Toaster` instance is mounted, the same
 * external-store shape sonner's own singleton store gave for free.
 */
export function Toaster() {
  const records = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <ToastPrimitive.Provider duration={DEFAULT_DURATION_MS} swipeDirection="right">
      {records.map((record) => (
        <ToastCard key={record.id} record={record} />
      ))}
      <ToastViewport />
    </ToastPrimitive.Provider>
  );
}
