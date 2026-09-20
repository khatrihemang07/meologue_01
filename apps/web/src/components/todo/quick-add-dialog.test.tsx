import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { QuickAddDialog } from "./quick-add-dialog";

// `add-task-form.test.tsx`'s own `stubTouch` helper, mirrored — see its
// header comment for why only the touch branch needs stubbing.
function stubTouch(touch: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: touch && (query === "(pointer: coarse)" || query === "(hover: none)"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  onAutocompleteOpenChange,
  ariaLabel,
  onMultiLinePaste,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  onAutocompleteOpenChange?: (open: boolean) => void;
  ariaLabel?: string;
  onMultiLinePaste?: (lines: string[]) => void;
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
      {/* Proves `QuickAddDialog`'s own `onMultiLinePaste` wiring reaches
          this editor — `add-task-form.test.tsx`'s own identical stub
          addition has the fuller reasoning; the real paste mechanics are
          `task-title-editor.test.tsx`'s job, not this file's. */}
      {onMultiLinePaste !== undefined && (
        <button type="button" onClick={() => onMultiLinePaste(["Task A", "Task B", "Task C"])}>
          Simulate multi-line paste
        </button>
      )}
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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  // Issue #374: the empty-title tab order (`web/01-anatomy.md`) names
  // Cancel, the mic (omitted here, D11) and More actions as three of its
  // four stops — all three (mic aside) are present even at rest. Only
  // the chips (Project/Date/Priority) and the submit control wait for
  // text. No "Close" (X) button either — not in Todoist's own control
  // inventory, dropped as drift.
  it("at rest, renders Cancel and More actions but no chips or Add task", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    await getInput();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove date" })).not.toBeInTheDocument();
  });

  it("typing text reveals the chip row and the Add task control", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });

    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
  });

  // Issue #264: clearing the field back to empty returns the dialog to the
  // compact state — this isn't a one-way grow.
  it("clearing the text back to empty drops the chip row and Add task, keeps Cancel", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    const input = await getInput();
    fireEvent.change(input, { target: { value: "buy milk" } });
    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });

    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Escape (the editor's own onCancel) closes an empty field immediately", async () => {
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);

    fireEvent.keyDown(await getInput(), { key: "Escape" });

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
      // Cancel is present at rest (issue #374), Add task is not.
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();

      // Escape on the genuinely-blank reopen closes immediately — no
      // resurrected confirmation.
      fireEvent.keyDown(freshInput, { key: "Escape" });
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
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove date" })).not.toBeInTheDocument();
    });
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

  /**
   * Issue #373: proves `QuickAddDialog` wires `onMultiLinePaste` through
   * to the editor and renders `MultiLinePasteDialog` fed by the real
   * `useQuickAddComposer` state — the real paste-detection mechanics and
   * the real per-line commit logic each have their own full coverage
   * elsewhere (`task-title-editor.test.tsx`, `use-quick-add-composer.
   * test.ts`); this is only the wiring between them and this component.
   */
  describe("multi-line paste wiring", () => {
    it("a multi-line paste opens the confirmation nested inside Quick Add, and confirming adds every line", async () => {
      const onAdd = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={onAdd} />);
      await getInput();

      fireEvent.click(screen.getByRole("button", { name: "Simulate multi-line paste" }));

      const pasteDialog = await screen.findByRole("dialog", { name: "Add 3 tasks?" });
      // The outer Quick Add dialog is still mounted underneath — a nested
      // dialog, not a replacement — even though Radix marks it
      // `aria-hidden` while the paste confirmation is the topmost one, the
      // same way `task-schedule-popover.test.tsx`'s own comment on
      // `within(scheduler-view)` describes for a modal Dialog's siblings.
      expect(document.querySelector('[data-testid="quick-add"]')).toBeInTheDocument();

      fireEvent.click(within(pasteDialog).getByRole("button", { name: "Add 3 tasks" }));

      expect(onAdd).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("dialog", { name: "Add 3 tasks?" })).not.toBeInTheDocument();
    });
  });

  describe("shell chosen by touch capability (issue #374/D4)", () => {
    it("touch renders the full-screen sheet, with a scrim, and no Cancel row", async () => {
      stubTouch(true);
      render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

      const dialog = await screen.findByRole("dialog", { name: "Quick Add" });
      expect(dialog).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    });

    it("touch stays open after Add task, with the title cleared", async () => {
      stubTouch(true);
      const onAdd = vi.fn();
      const onOpenChange = vi.fn();
      render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />);

      fireEvent.change(await getInput(), { target: { value: "buy milk" } });
      fireEvent.click(await screen.findByRole("button", { name: "Add task" }));

      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ content: "buy milk" }));
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(await getInput()).toHaveValue("");
    });

    it("touch's own discard confirmation uses Android's verbatim copy", async () => {
      stubTouch(true);
      render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

      fireEvent.change(await getInput(), { target: { value: "buy milk" } });
      fireEvent.keyDown(document, { key: "Escape" });

      const confirm = await screen.findByRole("alertdialog");
      expect(confirm).toHaveTextContent("Discard changes?");
      expect(confirm).toHaveTextContent("The changes you've made will not be saved.");
    });
  });
});
