import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { QuickAddDialog } from "./quick-add-dialog";

function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  onAutocompleteOpenChange,
  ariaLabel,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  onAutocompleteOpenChange?: (open: boolean) => void;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value);
  return (
    <div>
      <input
        aria-label={ariaLabel ?? "Task name"}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit(text);
          }
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      />
      <button type="button" onClick={() => onAutocompleteOpenChange?.(true)}>
        open popup
      </button>
      <button type="button" onClick={() => onAutocompleteOpenChange?.(false)}>
        close popup
      </button>
    </div>
  );
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

async function getInput(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText("Task name")) as HTMLInputElement;
}

describe("QuickAddDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ smartDatesEnabled: true });
  });

  it("renders nothing when closed", () => {
    render(<QuickAddDialog open={false} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as role=dialog aria-label=Quick Add, with the Task name editor, at rest", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    const dialog = await screen.findByRole("dialog", { name: "Quick Add" });
    expect(dialog).toBeInTheDocument();
    expect(await getInput()).toBeInTheDocument();
  });

  it("at rest, renders the compact single row with no footer toolbar", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    await getInput();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove date" })).not.toBeInTheDocument();
  });

  it("typing text reveals the footer toolbar row", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });

    expect(await screen.findByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
  });

  // Issue #264: clearing the field back to empty returns the dialog to the
  // compact state — this isn't a one-way grow.
  it("clearing the text back to empty returns the dialog to the compact state", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    const input = await getInput();
    fireEvent.change(input, { target: { value: "buy milk" } });
    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });

    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("calls onAdd with the parsed fields and closes on Add task", async () => {
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />);

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk", date: null, priority: 1 }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // Issue #265 — Cancel with text present now raises the discard
  // confirmation instead of closing straight through (the bug this ticket
  // fixes); "Cancel closes without adding" pre-#265 asserted the old,
  // unconfirmed behaviour directly and is folded into the describe block
  // below rather than kept as a stale duplicate.
  it("Cancel with an empty field closes immediately, with no confirmation", async () => {
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />);
    await getInput();

    // Cancel isn't even rendered at rest (the "compact single row, no
    // footer" test above already covers that); Escape is the only route an
    // empty field has, and it's covered by "Escape (the editor's own
    // onCancel) closes an empty field immediately" below.
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Escape (the editor's own onCancel) closes an empty field immediately", async () => {
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);

    fireEvent.keyDown(await getInput(), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // The X button and an outside click both travel through Root's own
  // `onOpenChange` (this file's own header comment on that prop) — the X
  // button is the one of the two a plain click can exercise directly.
  it("the X button closes an empty field immediately, with no confirmation", async () => {
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
    await getInput();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  describe("discard confirmation (issue #265)", () => {
    async function typeText(text: string) {
      fireEvent.change(await getInput(), { target: { value: text } });
    }

    // `task-detail-view.test.tsx`'s own `clickOutside` helper, reused
    // verbatim (that file's own header comment on the two real-browser
    // details this reproduces: Radix's `document` pointerdown listener is
    // registered behind a `setTimeout(0)`, and `Dialog.Content` defers to
    // a subsequent `click` on the same target rather than firing on
    // `pointerdown` alone).
    async function clickOutside(target: Element) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.pointerDown(target);
      fireEvent.click(target);
    }

    it("text + Escape raises the confirmation, with the measured wording", async () => {
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      await typeText("buy milk");

      fireEvent.keyDown(screen.getByLabelText("Task name"), { key: "Escape" });

      // Escape reaches `onOpenChange` from neither door yet — it's been
      // redirected into the confirmation instead of closing anything.
      expect(onOpenChange).not.toHaveBeenCalled();
      const confirm = await screen.findByRole("alertdialog");
      expect(confirm).toHaveTextContent("Discard unsaved changes?");
      expect(confirm).toHaveTextContent("Your unsaved changes will be discarded.");
      const buttons = within(confirm).getAllByRole("button");
      // DOM order matches the live capture: Cancel, then Discard.
      expect(buttons.map((button) => button.textContent)).toEqual(["Cancel", "Discard"]);
    });

    it("text + the footer's Cancel button raises the confirmation", async () => {
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      await typeText("buy milk");

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onOpenChange).not.toHaveBeenCalled();
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    });

    // Root's own `onOpenChange` — the door Escape-without-a-popup-open, an
    // outside click, and the X button all share (this file's own header
    // comment on `Root`'s `onOpenChange` prop). The X button is the one of
    // those three a plain `fireEvent.click` can exercise directly, without
    // faking a real Radix outside-pointerdown; the Escape variant of this
    // same door is the one the existing "does not close... while the
    // autocomplete popup is open" test below already dispatches at
    // `document`, matching real `DismissableLayer` capture-phase targeting.
    it("text + the X button raises the confirmation (Root's own onOpenChange door)", async () => {
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      await typeText("buy milk");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(onOpenChange).not.toHaveBeenCalled();
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    });

    it("text + Escape via Root's own document-capture door (no popup open) also raises it", async () => {
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      await typeText("buy milk");

      // The same `document`-targeted dispatch the pre-existing popup test
      // below uses — this is real `DismissableLayer` capture-phase Escape
      // handling, not the stubbed editor's own `onKeyDown`.
      fireEvent.keyDown(document, { key: "Escape" });

      expect(onOpenChange).not.toHaveBeenCalled();
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    });

    it("Cancel on the confirmation keeps the dialog open and preserves the typed text", async () => {
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      const input = await getInput();
      await typeText("buy milk");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const confirm = await screen.findByRole("alertdialog");

      fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      // The whole dialog itself was never told to close.
      expect(onOpenChange).not.toHaveBeenCalled();
      // The composer never remounted (no fresh `LazyTaskTitleEditor`
      // instance, no cleared field) — the typed text is exactly what was
      // there before Cancel was pressed on the confirmation.
      expect(input).toHaveValue("buy milk");
      expect(await screen.findByRole("dialog", { name: "Quick Add" })).toBeInTheDocument();
    });

    it("Discard closes both the confirmation and the whole dialog", async () => {
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      await typeText("buy milk");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const confirm = await screen.findByRole("alertdialog");

      fireEvent.click(within(confirm).getByRole("button", { name: "Discard" }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("text + an outside click raises the confirmation (the third door)", async () => {
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      await typeText("buy milk");

      await clickOutside(document.body);

      expect(onOpenChange).not.toHaveBeenCalled();
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    });

    // Regression for the live-pass bug: this dialog is always mounted
    // (`todo-page.tsx` renders `<QuickAddDialog open={quickAddOpen} .../>`
    // unconditionally, only toggling `open`), so `composer`'s own state
    // outlives a single open/close cycle unless something resets it.
    // Discard never called `commit`/`remount`, so `composer.value` (what
    // `hasText` reads) kept reading the discarded draft even once the
    // reopened editor's own document was genuinely empty — the
    // reset-on-open `useEffect` next to `composer.remount("")` above is
    // the fix; this is the exact repro sequence that caught it.
    // `rerender`, not a fresh `render`: a fresh render gives `composer` a
    // brand-new `useState` and could never have reproduced this — the bug
    // only exists because the real component persists across the cycle.
    it("issue #265 regression: type, Escape, Discard, reopen — the next open is genuinely blank, no stale confirmation", async () => {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />,
      );
      await typeText("buy milk");
      fireEvent.keyDown(screen.getByLabelText("Task name"), { key: "Escape" });
      const confirm = await screen.findByRole("alertdialog");
      fireEvent.click(within(confirm).getByRole("button", { name: "Discard" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

      // `todo-page.tsx`'s own real response to that `onOpenChange(false)`
      // call — flip `quickAddOpen` to `false`, then (the reproduction's
      // own step 2) reopen it immediately, same page, no reload.
      rerender(<QuickAddDialog open={false} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      rerender(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);

      const freshInput = await getInput();
      expect(freshInput).toHaveValue("");
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();

      // Escape on the genuinely-blank reopen closes immediately — no
      // resurrected confirmation.
      fireEvent.keyDown(freshInput, { key: "Escape" });
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    // The reproduction's own second observation: the X button leaked the
    // identical stale state. Covered separately from the Escape cycle
    // above so a regression in either door's own wiring still fails.
    it("issue #265 regression: type, Escape, Discard, reopen — the X button also closes immediately, no stale confirmation", async () => {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />,
      );
      await typeText("buy milk");
      fireEvent.keyDown(screen.getByLabelText("Task name"), { key: "Escape" });
      const confirm = await screen.findByRole("alertdialog");
      fireEvent.click(within(confirm).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

      rerender(<QuickAddDialog open={false} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      rerender(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      await getInput();

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    // The narrower instance of the identical bug one layer deeper:
    // "Remove date" is the OTHER function that touches `composer.seed`
    // (`remount(stripped)`), so a type → Remove date → Escape → Discard
    // cycle used to leave `seed` itself stale too, not just `value` —
    // meaning the reopened editor would have come back pre-filled with
    // the date-stripped text, not genuinely blank. The same reset-on-open
    // effect covers both in one fix, since it resets via the identical
    // `composer.remount("")` call regardless of which path last touched
    // `seed`.
    it("issue #265 regression: type a date, Remove date, Escape, Discard, reopen — still genuinely blank", async () => {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />,
      );
      await typeText("buy milk tomorrow");
      fireEvent.click(await screen.findByRole("button", { name: "Remove date" }));
      expect(await getInput()).toHaveValue("buy milk");

      fireEvent.keyDown(await getInput(), { key: "Escape" });
      const confirm = await screen.findByRole("alertdialog");
      fireEvent.click(within(confirm).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

      rerender(<QuickAddDialog open={false} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
      rerender(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);

      expect(await getInput()).toHaveValue("");
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    });
  });

  it("shows a priority pill, with the flag coloured and the text left neutral, once p1 is typed", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    expect(screen.queryByText("P1")).not.toBeInTheDocument();

    fireEvent.change(await getInput(), { target: { value: "buy milk p1" } });

    const pillText = await screen.findByText("P1");
    expect(pillText).toBeInTheDocument();
    // The text itself carries no colour override of its own — its
    // *container* is what reads the shared neutral grey class; only the
    // flag icon (asserted below) carries the priority's own colour.
    expect(pillText.className).toBe("");
    expect(pillText.parentElement?.className).toContain("text-muted-foreground");
    const flag = pillText.parentElement?.querySelector("svg");
    expect(flag).not.toBeNull();
    expect(flag?.getAttribute("fill")).toBe("var(--td-priority-picker-1)");
  });

  it("shows no priority pill for the untyped default (no p[1-4] token)", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });

    expect(screen.queryByText(/^P[1-4]$/)).not.toBeInTheDocument();
  });

  it("shows Remove date once a date is recognised, and removes it from the field on click", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    fireEvent.change(await getInput(), { target: { value: "buy milk tomorrow" } });

    const removeDate = await screen.findByRole("button", { name: "Remove date" });
    fireEvent.click(removeDate);

    // A fresh editor instance, remounted with the date-stripped text
    // (this file's own header comment on why: the mounted ProseMirror doc
    // can't be edited from outside `task-title-editor.tsx`). Best-effort,
    // not a measured Todoist behaviour — see this ticket's own report.
    const input = await getInput();
    expect(input).toHaveValue("buy milk");
    expect(screen.queryByRole("button", { name: "Remove date" })).not.toBeInTheDocument();
  });

  it("does not close the dialog on Escape while the autocomplete popup is open", async () => {
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);
    await getInput();

    fireEvent.click(screen.getByRole("button", { name: "open popup" }));
    // Radix's own Escape handling fires on the dialog Content, not the
    // stubbed input — this is the same node real `DismissableLayer`
    // capture-phase handling targets (`document`), so dispatching there
    // exercises the identical `onEscapeKeyDown` guard.
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "close popup" }));
    fireEvent.keyDown(document, { key: "Escape" });

    // Radix's own dismissal now runs unopposed once the popup is closed.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
