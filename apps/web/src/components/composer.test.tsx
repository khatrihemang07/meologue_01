import type { Entry } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

function getTextarea() {
  return screen.getByPlaceholderText("What's on your mind?");
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "original body",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

/**
 * Composer's own edit-mode transitions (seeding from an Entry, restoring
 * the pre-edit draft) are driven entirely by `editingEntry` changing — the
 * state itself is owned by the page (composer-page.tsx), not by Composer.
 * A fixed `editingEntry` prop can't exercise "start editing mid-draft, then
 * cancel back to it," so this harness lifts the state exactly the way the
 * real page does, with a test-only button standing in for History's Edit
 * choice (which is what actually calls `setEditingEntry` in production).
 */
function EditableComposerHarness({
  entryToEdit,
  onSend = vi.fn(),
  onCommitEdit,
}: {
  entryToEdit: Entry;
  onSend?: (body: string) => void;
  onCommitEdit?: (id: string, body: string) => void;
}) {
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);
  return (
    <>
      <button type="button" onClick={() => setEditingEntry(entryToEdit)}>
        Start editing
      </button>
      <Composer
        onSend={onSend}
        editingEntry={editingEntry}
        onCommitEdit={(id, body) => {
          onCommitEdit?.(id, body);
          setEditingEntry(null);
        }}
        onCancelEdit={() => setEditingEntry(null)}
      />
    </>
  );
}

describe("Composer", () => {
  it("inserts a newline on plain Enter, without sending, on every platform (issue #76)", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    const event = fireEvent.keyDown(getTextarea(), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    // preventDefault() was not called — the textarea's own default
    // behaviour (inserting a newline) was left alone, the same as any
    // other unhandled key.
    expect(event).toBe(true);
  });

  it("sends on Cmd+Enter and clears the textarea", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });

    expect(onSend).toHaveBeenCalledWith("hello");
    expect(getTextarea()).toHaveValue("");
  });

  it("sends on Ctrl+Enter (vitest's mode falls through to the desktop rule)", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", ctrlKey: true });

    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("does not send on Shift+Enter, leaving the default newline behavior alone, even with a modifier also held", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    const event = fireEvent.keyDown(getTextarea(), {
      key: "Enter",
      shiftKey: true,
      metaKey: true,
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(event).toBe(true); // preventDefault() was not called
  });

  it("does not send whitespace-only input, on the chord or via the button", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "   " } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the send-chord hint, naming both modifiers under the test/web rule", () => {
    render(<Composer onSend={vi.fn()} />);

    expect(screen.getByText("⌘↵ or Ctrl↵ to send")).toBeInTheDocument();
  });

  it("sends when the Send button is clicked", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("disables the textarea and Send button while disabled", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled />);

    expect(getTextarea()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("ignores the send chord and the Send button while disabled", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).not.toHaveBeenCalled();
  });

  describe("editing an existing Entry (ADR 0028)", () => {
    it("seeds the field with the Entry's body once editing starts", () => {
      render(<EditableComposerHarness entryToEdit={entry({ body: "original body" })} />);

      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));

      expect(getTextarea()).toHaveValue("original body");
    });

    it("shows a visible indication that this is an edit, with a Cancel control", () => {
      render(<EditableComposerHarness entryToEdit={entry({})} />);

      expect(screen.queryByText("Editing Entry")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));

      expect(screen.getByText("Editing Entry")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel edit" })).toBeInTheDocument();
    });

    it("commits via onCommitEdit with the trimmed body, not onSend", () => {
      const onSend = vi.fn();
      const onCommitEdit = vi.fn();
      render(
        <EditableComposerHarness
          entryToEdit={entry({ id: "42", body: "original" })}
          onSend={onSend}
          onCommitEdit={onCommitEdit}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
      fireEvent.change(getTextarea(), { target: { value: "  edited body  " } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onCommitEdit).toHaveBeenCalledWith("42", "edited body");
      expect(onSend).not.toHaveBeenCalled();
    });

    it("refuses to commit an edit to empty/whitespace, exactly like an empty Send", () => {
      const onCommitEdit = vi.fn();
      render(
        <EditableComposerHarness entryToEdit={entry({ id: "42" })} onCommitEdit={onCommitEdit} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
      fireEvent.change(getTextarea(), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });

      expect(onCommitEdit).not.toHaveBeenCalled();
      // Still in edit mode — refusing the commit didn't silently fall back
      // to cancelling either.
      expect(screen.getByText("Editing Entry")).toBeInTheDocument();
    });

    it("Escape cancels editing without committing", () => {
      const onCommitEdit = vi.fn();
      render(
        <EditableComposerHarness
          entryToEdit={entry({ id: "42", body: "original" })}
          onCommitEdit={onCommitEdit}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
      fireEvent.change(getTextarea(), { target: { value: "changed my mind" } });
      fireEvent.keyDown(getTextarea(), { key: "Escape" });

      expect(onCommitEdit).not.toHaveBeenCalled();
      expect(screen.queryByText("Editing Entry")).not.toBeInTheDocument();
    });

    it("the visible Cancel control cancels editing without committing", () => {
      const onCommitEdit = vi.fn();
      render(
        <EditableComposerHarness entryToEdit={entry({ id: "42" })} onCommitEdit={onCommitEdit} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

      expect(onCommitEdit).not.toHaveBeenCalled();
      expect(screen.queryByText("Editing Entry")).not.toBeInTheDocument();
    });

    it("cancelling restores whatever was mid-composition before editing started", () => {
      render(<EditableComposerHarness entryToEdit={entry({ body: "original body" })} />);

      fireEvent.change(getTextarea(), { target: { value: "a draft in progress" } });
      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
      expect(getTextarea()).toHaveValue("original body");

      fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

      expect(getTextarea()).toHaveValue("a draft in progress");
    });

    it("committing also restores whatever was mid-composition before editing started", () => {
      const onCommitEdit = vi.fn();
      render(
        <EditableComposerHarness
          entryToEdit={entry({ id: "42", body: "original body" })}
          onCommitEdit={onCommitEdit}
        />,
      );

      fireEvent.change(getTextarea(), { target: { value: "a draft in progress" } });
      fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
      fireEvent.change(getTextarea(), { target: { value: "edited body" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onCommitEdit).toHaveBeenCalledWith("42", "edited body");
      expect(getTextarea()).toHaveValue("a draft in progress");
    });
  });
});
