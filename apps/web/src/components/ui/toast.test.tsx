/**
 * Issue #357 — coverage for the one thing sonner genuinely could not do:
 * a toast announcing itself to a screen reader without a hand-built
 * stand-in. These tests exercise the REAL `toast`/`Toaster` pair (no
 * `vi.mock`, unlike every call-site test in this app, which mocks this
 * module the same way they used to mock `sonner`) — the point here is
 * proving what Radix's own `Toast.Root` gives for free, not re-testing a
 * mock of it.
 *
 * `flushAnnouncement` exists because Radix's own `ToastAnnounce`
 * (`@radix-ui/react-toast@1.2.23`, `dist/index.mjs`) deliberately renders
 * its live-region content one tick after the toast itself mounts — two
 * `requestAnimationFrame`s inside a `useLayoutEffect` (`useNextFrame`),
 * not a React render this app's own code controls — so the browser
 * reliably announces a region whose content just changed rather than one
 * that already had it at creation. A bare `act()` around `toast(...)`
 * mounts the visible card but leaves the announcement's own hidden
 * region empty (confirmed against the real DOM before writing these
 * assertions); `flushAnnouncement` waits out those two frames the same
 * way a real browser tab would.
 *
 * Also covers the two pieces of queueing behaviour this module's own
 * header comment (`toast.tsx`) says are reimplemented by hand rather than
 * given by a library: the visible-toast cap, and `toast.dismiss` actually
 * removing a toast from the DOM.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster, toast } from "./toast";

async function flushAnnouncement() {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
}

afterEach(() => {
  // The store is a module-level singleton (by design — `toast(...)` has to
  // be reachable from outside any component, the same as sonner's own
  // singleton), so it outlives `cleanup()`'s DOM teardown between tests in
  // this file unless it's drained explicitly.
  act(() => {
    toast.dismiss();
  });
});

describe("toast/Toaster", () => {
  it("announces a plain toast's own message with a native role and aria-live, not a hand-built one", async () => {
    render(<Toaster />);

    act(() => {
      toast("Backed up this Device to backup.zip");
    });
    await flushAnnouncement();

    // Radix's own accessible pattern: a visually-hidden region carries the
    // announcement (`role="status"`, `aria-live="assertive"` for the
    // default `type="foreground"`) separately from the visible card —
    // there is no `role="alert"` this file has to author itself the way
    // `completion-toast.tsx` used to.
    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("aria-live", "assertive");
    expect(announcement).toHaveTextContent("Backed up this Device to backup.zip");
  });

  it("announces success and error toasts the same native way", async () => {
    render(<Toaster />);

    act(() => {
      toast.success("Exported 3 Entries and 1 Task to backup.zip.");
    });
    await flushAnnouncement();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Exported 3 Entries and 1 Task to backup.zip.",
    );

    act(() => {
      toast.dismiss();
      toast.error("Restore failed.");
    });
    await flushAnnouncement();
    expect(screen.getByRole("status")).toHaveTextContent("Restore failed.");
  });

  it("announces toast.custom content the same way — completion-toast.tsx's own body needs no role/aria-live of its own", async () => {
    render(<Toaster />);

    act(() => {
      toast.custom((id) => <div>Custom body {id}</div>);
    });
    await flushAnnouncement();

    // The text appears twice by design — once in the visible card, once in
    // Radix's own hidden announcer — so this asserts against the role
    // rather than a plain text query, which would find both.
    expect(screen.getByRole("status")).toHaveTextContent(/Custom body/);
  });

  it("renders an action button that carries the given label and fires onClick", () => {
    render(<Toaster />);
    let clicked = false;

    act(() => {
      toast("A new version of meologue is available.", {
        action: {
          label: "Reload",
          onClick: () => {
            clicked = true;
          },
        },
      });
    });

    const button = screen.getByRole("button", { name: "Reload" });
    act(() => {
      button.click();
    });
    expect(clicked).toBe(true);
  });

  it("toast.dismiss(id) removes exactly that toast from the DOM and fires its onDismiss", () => {
    render(<Toaster />);
    let dismissed = false;
    let id: string | number = "";

    act(() => {
      id = toast("Link copied", { onDismiss: () => (dismissed = true) });
    });
    expect(screen.getByText("Link copied")).toBeInTheDocument();

    act(() => {
      toast.dismiss(id);
    });
    expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
    expect(dismissed).toBe(true);
  });

  // Reimplemented by hand (`toast.tsx`'s own header comment): sonner's
  // default `visibleToasts` caps a stack at 3, queueing the rest
  // invisibly. This app has never raised more than two at once, so the
  // simplification here drops the oldest past the cap outright rather
  // than holding it back to reveal later — this proves the cap itself
  // holds, not sonner's own "reveal later" behaviour.
  it("caps the number of toasts on screen at once, dropping the oldest past the cap", () => {
    render(<Toaster />);
    let oldestDismissed = false;

    act(() => {
      toast("first", { onDismiss: () => (oldestDismissed = true) });
      toast("second");
      toast("third");
      toast("fourth");
    });

    expect(screen.queryByText("first")).not.toBeInTheDocument();
    expect(oldestDismissed).toBe(true);
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.getByText("third")).toBeInTheDocument();
    expect(screen.getByText("fourth")).toBeInTheDocument();
  });
});
