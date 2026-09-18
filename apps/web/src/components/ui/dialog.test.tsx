import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogClose, DialogContent, DialogPortal } from "./dialog";

function flush(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Harness({
  onCloseAutoFocus,
  restoreFocusTo,
  removeOpenerOnClose = false,
  focusSiblingOnClose = false,
  blurBeforeOpen = false,
}: {
  onCloseAutoFocus?: (event: Event) => void;
  restoreFocusTo?: "other";
  removeOpenerOnClose?: boolean;
  /**
   * Stands in for a sibling `FocusScope` (e.g. `task-schedule-popover.tsx`'s
   * own `PopoverContent`) that synchronously restores focus to its own,
   * real trigger the moment this dialog is told to close — *before*
   * Radix's own deferred `onCloseAutoFocus` dispatch for THIS dialog runs.
   * The regression this guards against: `DialogContent` used to call
   * `.focus()` unconditionally when it had no good target of its own,
   * which ran later and stole focus back from exactly this kind of
   * sibling restore.
   */
  focusSiblingOnClose?: boolean;
  /** Nothing focused before the dialog opens — the two-step `DropdownMenu` hand-off shape (`task-schedule-popover.tsx`'s own Repeat menu) that leaves `document.activeElement` as `document.body` at the moment this dialog's own capture runs. */
  blurBeforeOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openerMounted, setOpenerMounted] = useState(true);
  const otherRef = useRef<HTMLButtonElement>(null);
  const siblingRef = useRef<HTMLButtonElement>(null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      if (removeOpenerOnClose) setOpenerMounted(false);
      if (focusSiblingOnClose) siblingRef.current?.focus({ preventScroll: true });
    }
  }

  return (
    <div>
      {openerMounted && (
        <button
          type="button"
          data-testid="opener"
          onClick={(event) => {
            if (blurBeforeOpen) event.currentTarget.blur();
            setOpen(true);
          }}
        >
          Open
        </button>
      )}
      <button type="button" ref={otherRef} data-testid="other-target">
        Other
      </button>
      <button type="button" ref={siblingRef} data-testid="sibling-target">
        Sibling
      </button>
      {/* `modal={false}`, matching `TaskTimeDialog`/`TaskCustomRepeatDialog` —
          the two real surfaces the "stands aside" tests below reproduce.
          A modal Dialog's `FocusScope` runs a separate, `trapped`-focus
          effect (a global `focusin` listener that yanks focus back into
          the container whenever it lands outside it) that would fight
          `focusSiblingOnClose`'s own synchronous `.focus()` call for a
          reason that has nothing to do with this wrapper's own restore
          logic — using the real, non-modal shape is what keeps that
          confound out of these tests. */}
      <Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
        <DialogPortal>
          <DialogContent
            open={open}
            aria-describedby={undefined}
            onCloseAutoFocus={onCloseAutoFocus}
            restoreFocusTo={restoreFocusTo === "other" ? otherRef : undefined}
          >
            <span>Dialog title</span>
            <DialogClose asChild>
              <button type="button" data-testid="closer">
                Close
              </button>
            </DialogClose>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </div>
  );
}

async function openAndClose() {
  const opener = screen.getByTestId("opener") as HTMLButtonElement;
  opener.focus();
  fireEvent.click(opener);
  await flush();
  const closer = await screen.findByTestId("closer");
  fireEvent.click(closer);
  await flush();
  return opener;
}

/**
 * Renders inside a real `<div id="root">`, matching `index.html`/
 * `main.tsx`'s own shape. Load-bearing for the "stands aside" tests below:
 * without a real `#root` present, a mutant that reintroduces the removed
 * `focusAppRoot()` fallback (`document.getElementById("root")` returns
 * `null`, so the whole call is a silent no-op) would survive by accident,
 * not because the guard is sound — confirmed by deliberately re-adding
 * that fallback against the plain `render()` these tests used before this
 * container existed: every test still passed, for the wrong reason.
 */
function renderInAppRoot(ui: ReactElement) {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  render(ui, { container: root });
  return root;
}

describe("DialogContent focus restore (issue #342)", () => {
  it("restores focus to whatever was focused before the dialog opened, with no caller handler", async () => {
    render(<Harness />);
    const opener = await openAndClose();
    expect(screen.queryByTestId("closer")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("a caller onCloseAutoFocus that calls preventDefault() fully suppresses this wrapper's own restore", async () => {
    let called = false;
    render(
      <Harness
        onCloseAutoFocus={(event) => {
          called = true;
          event.preventDefault();
          (screen.getByTestId("other-target") as HTMLButtonElement).focus();
        }}
      />,
    );
    const opener = await openAndClose();
    expect(called).toBe(true);
    // The wrapper's own generic restore would have targeted `opener`
    // (whatever was focused before open) — proving focus landed on the
    // caller's own target instead, not `opener`, is what proves the
    // wrapper's restore never ran.
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).toBe(screen.getByTestId("other-target"));
  });

  it("a caller onCloseAutoFocus that does NOT call preventDefault() still falls through to the generic restore", async () => {
    let called = false;
    render(
      <Harness
        onCloseAutoFocus={() => {
          called = true;
          // Deliberately no preventDefault() — mirrors task-detail-view.tsx's
          // discard-confirm ConfirmDialog when `discardConfirmedRef` is true.
        }}
      />,
    );
    const opener = await openAndClose();
    expect(called).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("restoreFocusTo wins over the generically-captured previously-focused element", async () => {
    render(<Harness restoreFocusTo="other" />);
    const opener = await openAndClose();
    const other = screen.getByTestId("other-target");
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(opener);
  });

  it("stands aside — never forces #root or any other target — when the captured element is disconnected at close, so a sibling scope's own restore survives untouched", async () => {
    const root = renderInAppRoot(<Harness removeOpenerOnClose focusSiblingOnClose />);
    try {
      await openAndClose();
      const sibling = screen.getByTestId("sibling-target");
      // The regression this reproduces: a prior version of DialogContent
      // forced focus onto a real, focusable `#root` fallback whenever it
      // had no good target, which ran *after* the sibling's own
      // synchronous restore (set in `onOpenChange`, always before Radix's
      // own deferred `onCloseAutoFocus` dispatch for this dialog) and
      // stole focus back from it. Asserting the sibling target — with a
      // real `#root` present to steal it TO, so a mutant reintroducing
      // that fallback has something to actually grab — is what proves
      // this wrapper did not do that.
      expect(document.activeElement).toBe(sibling);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).not.toBe(root);
    } finally {
      root.remove();
    }
  });

  it("treats a capture of document.body (nothing was focused before open) the same as no capture — stands aside rather than restoring to body", async () => {
    const root = renderInAppRoot(<Harness blurBeforeOpen focusSiblingOnClose />);
    try {
      const opener = screen.getByTestId("opener") as HTMLButtonElement;
      opener.focus();
      fireEvent.click(opener); // handler blurs `opener` before flipping `open`
      await flush();
      const closer = await screen.findByTestId("closer");
      fireEvent.click(closer);
      await flush();
      const sibling = screen.getByTestId("sibling-target");
      // If a captured `document.body` were treated as a "good" target,
      // this wrapper would call `event.preventDefault()` and (harmlessly,
      // since `body` isn't really focusable) attempt `document.body.
      // focus()` — which happens to be observationally identical to
      // standing aside in isolation. What it is NOT identical to:
      // composing correctly is still the same code path as the sibling-
      // restore test above, so this is asserted the same way for
      // consistency, not because this specific scenario can distinguish
      // "rejected body" from "harmlessly restored to a no-op body target"
      // by outcome alone in jsdom.
      expect(document.activeElement).toBe(sibling);
      expect(document.activeElement).not.toBe(root);
    } finally {
      root.remove();
    }
  });
});
