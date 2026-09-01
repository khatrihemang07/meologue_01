import type { Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskRow } from "./task-row";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function renderRow(overrides: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const props = {
    task: task(),
    onComplete: vi.fn(),
    onRequestDelete: vi.fn(),
    isDropTarget: false,
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    ...overrides,
  };
  render(
    <ul>
      <TaskRow {...props} />
    </ul>,
  );
  return props;
}

describe("TaskRow", () => {
  it("renders the Task's content, with the checkbox unticked", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.getByText("call mum")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "call mum" })).not.toBeChecked();
  });

  it("ticking the checkbox calls onComplete", () => {
    const onComplete = vi.fn();
    renderRow({ onComplete });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("the delete button calls onRequestDelete, not the store directly", () => {
    const onRequestDelete = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onRequestDelete });

    fireEvent.click(screen.getByRole("button", { name: 'Delete "call mum"' }));

    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  it("is draggable, and forwards drag events to the handlers it's given", () => {
    const onDragStart = vi.fn();
    const onDragOver = vi.fn();
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();
    renderRow({ onDragStart, onDragOver, onDrop, onDragEnd });

    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("draggable", "true");

    fireEvent.dragStart(row);
    fireEvent.dragOver(row);
    fireEvent.drop(row);
    fireEvent.dragEnd(row);

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragOver).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("draws the drop indicator only while it is the drop target", () => {
    renderRow({ isDropTarget: true });

    expect(screen.getByRole("listitem")).toHaveClass("border-t-primary");
  });
});
