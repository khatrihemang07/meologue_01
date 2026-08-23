import type { Entry } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryActionsSheet, EntryHoverActions, hoverCapable } from "./entry-actions";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

/** Same stand-in as entry-row.test.tsx's — see its own comment. */
function stubHoverCapable(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches, media: query })),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hoverCapable", () => {
  it("reflects matchMedia('(hover: hover)')", () => {
    stubHoverCapable(true);
    expect(hoverCapable()).toBe(true);

    stubHoverCapable(false);
    expect(hoverCapable()).toBe(false);
  });

  it("reads false when matchMedia isn't available at all", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(hoverCapable()).toBe(false);
  });
});

describe("EntryHoverActions", () => {
  it("calls onEdit with the whole Entry when Edit is pressed", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const target = entry({});
    render(<EntryHoverActions entry={target} onEdit={onEdit} onDelete={onDelete} />);

    fireEvent.click(screen.getByLabelText("Edit"));

    expect(onEdit).toHaveBeenCalledWith(target);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("calls onDelete with the whole Entry when Delete is pressed", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const target = entry({});
    render(<EntryHoverActions entry={target} onEdit={onEdit} onDelete={onDelete} />);

    fireEvent.click(screen.getByLabelText("Delete"));

    expect(onDelete).toHaveBeenCalledWith(target);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("stops a button press from also bubbling to an ancestor's row-tap handler", () => {
    const onEdit = vi.fn();
    const onRowClick = vi.fn();
    const target = entry({});
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: this stand-in ancestor only exists to prove the click doesn't bubble to it; it isn't the row itself.
      // biome-ignore lint/a11y/useKeyWithClickEvents: same reason.
      <div onClick={onRowClick}>
        <EntryHoverActions entry={target} onEdit={onEdit} onDelete={vi.fn()} />
      </div>,
    );

    fireEvent.click(screen.getByLabelText("Edit"));

    expect(onEdit).toHaveBeenCalledWith(target);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe("EntryActionsSheet", () => {
  it("renders nothing open when entry is null", () => {
    render(
      <EntryActionsSheet entry={null} onOpenChange={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("shows Edit and Delete when entry is set", () => {
    render(
      <EntryActionsSheet
        entry={entry({})}
        onOpenChange={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("calls onEdit with the open Entry and closes when Edit is pressed", () => {
    const onEdit = vi.fn();
    const onOpenChange = vi.fn();
    const target = entry({});
    render(
      <EntryActionsSheet
        entry={target}
        onOpenChange={onOpenChange}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Edit"));

    expect(onEdit).toHaveBeenCalledWith(target);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onDelete with the open Entry and closes when Delete is pressed", () => {
    const onDelete = vi.fn();
    const onOpenChange = vi.fn();
    const target = entry({});
    render(
      <EntryActionsSheet
        entry={target}
        onOpenChange={onOpenChange}
        onEdit={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByText("Delete"));

    expect(onDelete).toHaveBeenCalledWith(target);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
