import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DraftPrioritySheet } from "./draft-priority-sheet";

describe("DraftPrioritySheet", () => {
  it("titles itself 'Priority', not 'Schedule \"...\"' — it has no Task to name", () => {
    render(
      <DraftPrioritySheet open={true} onOpenChange={vi.fn()} uiPriority={4} onSelect={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "Priority", level: 2 })).toBeInTheDocument();
  });

  it("renders no Deadline section", () => {
    render(
      <DraftPrioritySheet open={true} onOpenChange={vi.fn()} uiPriority={4} onSelect={vi.fn()} />,
    );

    expect(screen.queryByText("Deadline")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick a deadline" })).not.toBeInTheDocument();
  });

  it("renders the same P1-P4 picker as the Task-coupled sheet, and reports the plain UI priority picked", () => {
    const onSelect = vi.fn();
    render(
      <DraftPrioritySheet open={true} onOpenChange={vi.fn()} uiPriority={4} onSelect={onSelect} />,
    );

    expect(screen.getByRole("button", { name: "P1" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "P4" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "P3" }));

    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("renders nothing while closed", () => {
    render(
      <DraftPrioritySheet open={false} onOpenChange={vi.fn()} uiPriority={4} onSelect={vi.fn()} />,
    );

    expect(screen.queryByText("Priority")).not.toBeInTheDocument();
  });
});
