import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiLinePasteDialog } from "./multiline-paste-dialog";

/**
 * Issue #373's own "Add N tasks?" confirmation. Copy is verbatim from
 * `.scratch/todoist-add-todo/web/04-interaction.md`'s captured modal — see
 * `multiline-paste-dialog.tsx`'s own header comment for the source quote.
 */
describe("MultiLinePasteDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderDialog(lines: readonly string[] | null) {
    const onConfirmSplit = vi.fn();
    const onConfirmMerge = vi.fn();
    const onCancel = vi.fn();
    render(
      <MultiLinePasteDialog
        lines={lines}
        onConfirmSplit={onConfirmSplit}
        onConfirmMerge={onConfirmMerge}
        onCancel={onCancel}
      />,
    );
    return { onConfirmSplit, onConfirmMerge, onCancel };
  }

  it("renders nothing when lines is null", () => {
    renderDialog(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the count in the title, and the exact verbatim description", () => {
    renderDialog(["Task A", "Task B", "Task C"]);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Add 3 tasks?")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Each line from your pasted text will be added as a separate task."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add 3 tasks" })).toBeInTheDocument();
  });

  it("omits Todoist's own 'scan text for tasks' upsell link — nothing behind it here (D11)", () => {
    renderDialog(["Task A", "Task B"]);
    expect(screen.queryByText(/scan text for tasks/i)).toBeNull();
  });

  it("confirming with the checkbox unchecked calls onConfirmSplit, never onConfirmMerge", () => {
    const { onConfirmSplit, onConfirmMerge, onCancel } = renderDialog(["Task A", "Task B"]);

    fireEvent.click(screen.getByRole("button", { name: "Add 2 tasks" }));

    expect(onConfirmSplit).toHaveBeenCalledTimes(1);
    expect(onConfirmMerge).not.toHaveBeenCalled();
    // The confirm-close ref guard (this component's own header comment):
    // a successful confirm must not ALSO read as a dismissal.
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("checking 'Merge to single task' relabels the primary button and calls onConfirmMerge instead", () => {
    const { onConfirmSplit, onConfirmMerge } = renderDialog(["Task A", "Task B", "Task C"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Merge to single task" }));
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onConfirmMerge).toHaveBeenCalledTimes(1);
    expect(onConfirmSplit).not.toHaveBeenCalled();
  });

  it("Cancel calls onCancel and neither confirm handler", () => {
    const { onConfirmSplit, onConfirmMerge, onCancel } = renderDialog(["Task A", "Task B"]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirmSplit).not.toHaveBeenCalled();
    expect(onConfirmMerge).not.toHaveBeenCalled();
  });

  it("Escape calls onCancel", () => {
    const { onCancel } = renderDialog(["Task A", "Task B"]);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("re-rendering with a fresh set of lines (a second paste) does not carry a checked Merge box over", () => {
    const onConfirmSplit = vi.fn();
    const onConfirmMerge = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <MultiLinePasteDialog
        lines={["Task A", "Task B"]}
        onConfirmSplit={onConfirmSplit}
        onConfirmMerge={onConfirmMerge}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge to single task" }));
    expect(screen.getByRole("checkbox", { name: "Merge to single task" })).toBeChecked();

    // Close, then a fresh paste opens it again.
    rerender(
      <MultiLinePasteDialog
        lines={null}
        onConfirmSplit={onConfirmSplit}
        onConfirmMerge={onConfirmMerge}
        onCancel={onCancel}
      />,
    );
    rerender(
      <MultiLinePasteDialog
        lines={["Task X", "Task Y", "Task Z"]}
        onConfirmSplit={onConfirmSplit}
        onConfirmMerge={onConfirmMerge}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Merge to single task" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Add 3 tasks" })).toBeInTheDocument();
  });
});
