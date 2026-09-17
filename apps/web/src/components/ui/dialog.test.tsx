/**
 * Issue #342 — `DialogContent`'s own focus-restore contract, isolated
 * from any real dialog surface. Every test here drains a real
 * `setTimeout(0)` tick after closing before asserting (`flush` below) —
 * `@radix-ui/react-focus-scope`'s own unmount effect defers its
 * `AUTOFOCUS_ON_UNMOUNT` dispatch by exactly that (`task-detail-view.tsx`'s
 * own DET-15 comment already documents this as a real async gap in Radix,
 * not a jsdom quirk to paper over) — and every test drives a REAL click on
 * a REAL `DialogClose` button (`fireEvent.click`, not a bare state flip),
 * so what's exercised is the genuine Radix `onCloseAutoFocus` dispatch
 * path, not a hand-simulated stand-in for it.
 *
 * These tests do not, and cannot, stand in for the two-Dialog-inside-a-
 * Popover shape `task-schedule-popover.tsx` builds around `TaskTimeDialog`/
 * `TaskCustomRepeatDialog` (jsdom lays out no popover and reproduces
 * neither `FocusScope` nor pointer dismissal — this repo's own established
 * limit, `task-command-menu.tsx`'s own header comment). What they DO prove
 * is `DialogContent`'s own composition contract in isolation: a caller's
 * `onCloseAutoFocus` that calls `preventDefault()` fully suppresses this
 * wrapper's own restore, exactly the guarantee `task-detail-view.tsx`'s
 * discard-confirm `ConfirmDialog` and `TaskActivityDialog`'s own
 * `restoreFocusTo` depend on.
 */
import { fireEvent, render, screen } from "@testing-library/react";
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
}: {
  onCloseAutoFocus?: (event: Event) => void;
  restoreFocusTo?: "other";
  removeOpenerOnClose?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openerMounted, setOpenerMounted] = useState(true);
  const otherRef = useRef<HTMLButtonElement>(null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && removeOpenerOnClose) {
      setOpenerMounted(false);
    }
  }

  return (
    <div>
      {openerMounted && (
        <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
          Open
        </button>
      )}
      <button type="button" ref={otherRef} data-testid="other-target">
        Other
      </button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
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

describe("DialogContent focus restore (issue #342)", () => {
  it("restores focus to whatever was focused before the dialog opened, with no caller handler", async () => {
    render(<Harness />);
    const opener = screen.getByTestId("opener") as HTMLButtonElement;
    opener.focus();
    fireEvent.click(opener);
    await flush();
    const closer = await screen.findByTestId("closer");
    fireEvent.click(closer);
    await flush();
    expect(screen.queryByTestId("closer")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("never leaves focus on document.body once the dialog is gone", async () => {
    render(<Harness />);
    await openAndClose();
    expect(document.activeElement).not.toBe(document.body);
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

  it("falls back to #root, never document.body, when the captured element is gone at close", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    try {
      render(<Harness removeOpenerOnClose />, { container: root });
      await openAndClose();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(root);
      expect(root.getAttribute("tabindex")).toBe("-1");
    } finally {
      root.remove();
    }
  });
});
