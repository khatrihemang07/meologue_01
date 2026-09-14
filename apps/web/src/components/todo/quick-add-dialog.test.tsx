import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { QuickAddDialog } from "./quick-add-dialog";

/**
 * Stands in for the real `TaskTitleEditor` — the identical reason
 * `add-task-form.test.tsx`'s own header comment gives (jsdom cannot
 * usefully mount a real ProseMirror `EditorView`). `onAutocompleteOpenChange`
 * is wired to a fake "toggle popup" button so the Escape-vs-popup guard
 * (QA-13/QA-14, the Radix trap `quick-add-dialog.tsx`'s own header comment
 * documents) can be exercised without a real autocomplete plugin.
 */
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

  // QA-13/QA-15/QA-16/NAV-07 (parity ledger): the real Quick Add dialog,
  // identity-asserted the same way the live capture was
  // (`role="dialog"`/`aria-label="Quick Add"`).
  it("opens as role=dialog aria-label=Quick Add, with the Task name editor, at rest", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    const dialog = await screen.findByRole("dialog", { name: "Quick Add" });
    expect(dialog).toBeInTheDocument();
    expect(await getInput()).toBeInTheDocument();
  });

  // Issue #264: at rest (empty composer) the footer toolbar row is absent
  // entirely — meologue now matches Todoist's 66px "single compact row"
  // rather than always rendering the footer. A plain dismiss (X) affordance
  // replaces Todoist's red Ramble/dictate button, which meologue has no
  // feature behind (QA-15 — this file's own header comment records that
  // divergence as a known open item, not something papered over).
  it("at rest, renders the compact single row with no footer toolbar", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    await getInput();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove date" })).not.toBeInTheDocument();
  });

  // Issue #264: typing anything grows the dialog and reveals the footer —
  // the recorded subset of controls (More actions, Cancel, Add task; QA-15
  // "Remove date" is additionally conditional on a recognised date, covered
  // separately below).
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
    // QA-19 (matched, live-driven): Shift+Enter closed/cleared Quick Add
    // on both sides — a real Add closes the whole dialog here too.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Cancel closes without adding", async () => {
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />);

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Escape (the editor's own onCancel) closes the dialog", async () => {
    const onOpenChange = vi.fn();
    render(<QuickAddDialog open={true} onOpenChange={onOpenChange} onAdd={vi.fn()} />);

    fireEvent.keyDown(await getInput(), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // PRI-04 (parity ledger): the pill's flag icon carries the priority's
  // colour; its "P1" text stays the shared neutral grey class
  // (`text-muted-foreground`), never a coloured span of its own.
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
    // `priorityPickerColour` returns the *token* (`var(--td-priority-
    // picker-1)`), matching PRI-04's own instruction ("matching the
    // picker") — the same P1 token `scheduler-and-priority.md` §10b
    // resolves to `rgb(209,69,59)` at runtime, not a literal this
    // component re-derives.
    const flag = pillText.parentElement?.querySelector("svg");
    expect(flag).not.toBeNull();
    expect(flag?.getAttribute("fill")).toBe("var(--td-priority-picker-1)");
  });

  it("shows no priority pill for the untyped default (no p[1-4] token)", async () => {
    render(<QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });

    expect(screen.queryByText(/^P[1-4]$/)).not.toBeInTheDocument();
  });

  // QA-15/QA-16: a recognised date grows the footer with a "Remove date"
  // control.
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

  // QA-13/QA-14's own Radix trap, named in this file's header comment:
  // Escape must close an open `#`/`@` popup first, not the whole dialog.
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
