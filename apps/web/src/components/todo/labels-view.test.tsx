import type { Label } from "@meologue/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LabelsView } from "./labels-view";

function label(overrides: Partial<Label> = {}): Label {
  return {
    id: "l1",
    deviceId: "device-a",
    name: "Work",
    colour: "#DC4C3E",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function renderLabelsView(overrides: Partial<Parameters<typeof LabelsView>[0]> = {}) {
  const props: Parameters<typeof LabelsView>[0] = {
    labels: [],
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onSetColour: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  return { ...render(<LabelsView {...props} />), props };
}

/** Opens the given row's "Label options menu" (STR-05) and clicks the named item. */
function openRowMenuAndClick(rowIndex: number, itemName: string) {
  // Radix's `DropdownMenu.Trigger` opens on `pointerdown`, not `click`
  // (task-schedule-popover.test.tsx's own identical "Repeat menu"
  // precedent) — a plain `fireEvent.click` alone never opens it under
  // jsdom.
  const triggers = screen.getAllByRole("button", { name: "Label options menu" });
  const trigger = triggers[rowIndex];
  if (trigger === undefined) throw new Error(`No Label row at index ${rowIndex}`);
  fireEvent.pointerDown(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: itemName }));
}

describe("LabelsView — Add label dialog (STR-04)", () => {
  it("shows an empty message with no Labels yet", () => {
    renderLabelsView();

    expect(screen.getByText(/No Labels yet/)).toBeInTheDocument();
  });

  it("opens the Add label dialog from the page's own Add button", async () => {
    renderLabelsView();

    fireEvent.click(screen.getByRole("button", { name: "Add label" }));

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Add label" })).toBeInTheDocument();
    expect(screen.getByLabelText("Label name")).toHaveValue("");
  });

  it("Add is disabled until a name is typed, and shows the 0/60 counter", async () => {
    renderLabelsView();
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    expect(screen.getByText("0/60")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "Errands" } });

    expect(screen.getByText("7/60")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled();
  });

  it("caps the name field at 60 characters (defect 32)", async () => {
    renderLabelsView();
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    expect(screen.getByLabelText("Label name")).toHaveAttribute("maxLength", "60");
  });

  it("submits the typed name and the selected colour, then closes", async () => {
    const onAdd = vi.fn();
    renderLabelsView({ onAdd });
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Label colour"), { target: { value: "#369307" } });
    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "Errands" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith("Errands", "#369307");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel discards without calling onAdd", async () => {
    const onAdd = vi.fn();
    renderLabelsView({ onAdd });
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "Errands" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onAdd).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  // A reopen after an abandoned Add must start blank again, not with
  // whatever was typed and cancelled last time — `LabelsView` remounts
  // `LabelDialog` fresh on every open (its own `key` on `dialogTarget`).
  it("reopening Add after Cancel starts blank again, not with the discarded text", async () => {
    renderLabelsView();

    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "Discarded" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Add label" }));

    await waitFor(() => expect(screen.getByLabelText("Label name")).toHaveValue(""));
  });
});

describe("LabelsView — options menu (STR-05)", () => {
  it("offers exactly Edit and Delete, in that order", () => {
    renderLabelsView({ labels: [label()] });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Label options menu" }));

    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
  });
});

describe("LabelsView — Edit label dialog (STR-04)", () => {
  it("Edit opens the dialog prefilled with the Label's current name and colour", async () => {
    renderLabelsView({ labels: [label({ name: "Work", colour: "#DC4C3E" })] });

    openRowMenuAndClick(0, "Edit");

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText("Edit label")).toBeInTheDocument();
    expect(screen.getByLabelText("Label name")).toHaveValue("Work");
    expect(screen.getByLabelText("Label colour")).toHaveValue("#DC4C3E");
  });

  it("renames through the dialog, trimmed, only when it changed", async () => {
    const onRename = vi.fn();
    renderLabelsView({ labels: [label({ name: "Work" })], onRename });

    openRowMenuAndClick(0, "Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "  Home  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).toHaveBeenCalledWith("l1", "Home");
  });

  it("does not rename when the name is unchanged", async () => {
    const onRename = vi.fn();
    renderLabelsView({ labels: [label({ name: "Work" })], onRename });

    openRowMenuAndClick(0, "Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).not.toHaveBeenCalled();
  });

  it("recolours through the dialog's own colour field", async () => {
    const onSetColour = vi.fn();
    renderLabelsView({ labels: [label({ id: "l1", colour: "#DC4C3E" })], onSetColour });

    openRowMenuAndClick(0, "Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Label colour"), { target: { value: "#4180FF" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSetColour).toHaveBeenCalledWith("l1", "#4180FF");
  });

  it("Cancel discards edits", async () => {
    const onRename = vi.fn();
    const onSetColour = vi.fn();
    renderLabelsView({ labels: [label({ name: "Work" })], onRename, onSetColour });

    openRowMenuAndClick(0, "Edit");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "Home" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(onSetColour).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("LabelsView — delete (STR-03, unchanged wording)", () => {
  // Verbatim (meologue-parity-docs/todoist/quick-add.md § "Destructive
  // confirmation wording"): "Delete label? The <name> label will be
  // permanently deleted." Buttons Cancel/Delete.
  it("Delete in the options menu shows Todoist's own verbatim delete wording", async () => {
    renderLabelsView({ labels: [label({ name: "Work" })] });

    openRowMenuAndClick(0, "Delete");

    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(within(screen.getByRole("alertdialog")).getByText("Delete label?")).toBeInTheDocument();
    expect(
      within(screen.getByRole("alertdialog")).getByText(
        "The Work label will be permanently deleted.",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
  });

  it("only calls onRemove after the confirmation, not on the request alone", async () => {
    const onRemove = vi.fn();
    renderLabelsView({ labels: [label()], onRemove });

    openRowMenuAndClick(0, "Delete");
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    expect(onRemove).toHaveBeenCalledWith("l1");
  });

  it("cancelling leaves the Label untouched", async () => {
    const onRemove = vi.fn();
    renderLabelsView({ labels: [label()], onRemove });

    openRowMenuAndClick(0, "Delete");
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );

    expect(onRemove).not.toHaveBeenCalled();
  });
});
