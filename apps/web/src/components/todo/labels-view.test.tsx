import type { Label } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("LabelsView — create", () => {
  it("shows an empty message with no Labels yet", () => {
    renderLabelsView();

    expect(screen.getByText(/No Labels yet/)).toBeInTheDocument();
  });

  it("Add is disabled until a name is typed", () => {
    renderLabelsView();

    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("New Label's name"), {
      target: { value: "Errands" },
    });

    expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled();
  });

  it("submits the typed name and the selected colour, then clears the field", () => {
    const onAdd = vi.fn();
    renderLabelsView({ onAdd });

    fireEvent.change(screen.getByLabelText("New Label's colour"), {
      target: { value: "#369307" },
    });
    fireEvent.change(screen.getByLabelText("New Label's name"), {
      target: { value: "Errands" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith("Errands", "#369307");
    expect(screen.getByLabelText("New Label's name")).toHaveValue("");
  });

  it("ignores blank input on submit", () => {
    const onAdd = vi.fn();
    renderLabelsView({ onAdd });

    fireEvent.change(screen.getByLabelText("New Label's name"), { target: { value: "   " } });
    fireEvent.submit(screen.getByLabelText("New Label's name").closest("form") as HTMLFormElement);

    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("LabelsView — rename and recolour", () => {
  it("commits a rename on blur, trimmed, only when it actually changed", () => {
    const onRename = vi.fn();
    renderLabelsView({ labels: [label({ name: "Work" })], onRename });

    const input = screen.getByLabelText("Label name");
    fireEvent.change(input, { target: { value: "  Home  " } });
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith("l1", "Home");
  });

  it("does not rename when the field blurs unchanged", () => {
    const onRename = vi.fn();
    renderLabelsView({ labels: [label({ name: "Work" })], onRename });

    const input = screen.getByLabelText("Label name");
    fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
  });

  it("recolours through the per-row colour select", () => {
    const onSetColour = vi.fn();
    renderLabelsView({ labels: [label({ id: "l1", colour: "#DC4C3E" })], onSetColour });

    fireEvent.change(screen.getByLabelText('"Work"\'s colour'), {
      target: { value: "#4180FF" },
    });

    expect(onSetColour).toHaveBeenCalledWith("l1", "#4180FF");
  });
});

describe("LabelsView — delete", () => {
  // Verbatim (docs/reference/todoist/quick-add.md § "Destructive
  // confirmation wording"): "Delete label? The <name> label will be
  // permanently deleted." Buttons Cancel/Delete.
  it("shows Todoist's own verbatim delete wording", async () => {
    renderLabelsView({ labels: [label({ name: "Work" })] });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Label "Work"' }));

    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(screen.getByText("Delete label?")).toBeInTheDocument();
    expect(screen.getByText("The Work label will be permanently deleted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("only calls onRemove after the confirmation, not on the request alone", async () => {
    const onRemove = vi.fn();
    renderLabelsView({ labels: [label()], onRemove });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Label "Work"' }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onRemove).toHaveBeenCalledWith("l1");
  });

  it("cancelling leaves the Label untouched", async () => {
    const onRemove = vi.fn();
    renderLabelsView({ labels: [label()], onRemove });

    fireEvent.click(screen.getByRole("button", { name: 'Delete Label "Work"' }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRemove).not.toHaveBeenCalled();
  });
});
