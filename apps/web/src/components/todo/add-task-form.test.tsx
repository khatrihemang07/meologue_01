import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddTaskForm } from "./add-task-form";

describe("AddTaskForm", () => {
  it("calls onAdd with the typed text on submit, and clears the field", () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);

    const field = screen.getByLabelText("Add a Task");
    fireEvent.change(field, { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith("buy milk");
    expect(field).toHaveValue("");
  });

  it("does not call onAdd for blank input", () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);

    fireEvent.change(screen.getByLabelText("Add a Task"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables the field and button while the store isn't ready", () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={true} />);

    expect(screen.getByLabelText("Add a Task")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });
});
