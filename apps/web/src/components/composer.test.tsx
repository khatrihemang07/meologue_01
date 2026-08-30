import type { Entry } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as entryDayModule from "@/lib/entry-day";
import { Composer } from "./composer";

function getTextarea() {
  return screen.getByPlaceholderText("What's on your mind?");
}

/** Pins the Device's UTC offset (issue #144's date suggestions read it off `deviceUtcOffsetMinutes()`) so which calendar day a UTC instant falls on doesn't depend on whichever host and timezone happens to run the suite — the same idea as history.test.tsx's own `pinClock`, minus the fake system clock this file's tests have no need of. */
function stubOffset(offsetMinutes = 0) {
  vi.spyOn(entryDayModule, "deviceUtcOffsetMinutes").mockReturnValue(offsetMinutes);
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("does not show the send-chord hint", () => {
    render(<Composer onSend={vi.fn()} />);

    expect(screen.queryByText("⌘↵ or Ctrl↵ to send")).not.toBeInTheDocument();
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

  // Issue #144: typing `[[` opens an inline list offering both kinds of
  // Reference (ADR 0042) without ever making the reader see or type an id.
  // Every test here fires at least two separate `fireEvent.change` calls
  // for the trigger itself — `derivePicker` (composer.tsx) deliberately
  // opens only when the caret sits immediately after a freshly-typed `[[`,
  // the same thing a real keystroke-by-keystroke `onChange` would report,
  // which a single jump straight to a longer string does not.
  describe("the inline [[ picker", () => {
    it("opens a list after typing [[", () => {
      render(<Composer onSend={vi.fn()} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });

      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("does not open for a [[ that arrives as part of a larger pasted change", () => {
      render(<Composer onSend={vi.fn()} />);

      fireEvent.change(getTextarea(), { target: { value: "some [[text pasted at once" } });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("Escape closes the list without inserting anything", () => {
      render(<Composer onSend={vi.fn()} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      fireEvent.keyDown(getTextarea(), { key: "Escape" });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(getTextarea()).toHaveValue("[[");
    });

    it("choosing a recent day inserts [[YYYY-MM-DD]]", () => {
      stubOffset(0);
      const recentEntries = [entry({ id: "r1", createdAt: "2026-08-15T12:00:00.000Z" })];
      render(<Composer onSend={vi.fn()} recentEntries={recentEntries} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      fireEvent.click(screen.getByText("2026-08-15"));

      expect(getTextarea()).toHaveValue("[[2026-08-15]]");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("accepts a fully typed YYYY-MM-DD even when it is not among the recent days", () => {
      render(<Composer onSend={vi.fn()} recentEntries={[]} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      fireEvent.change(getTextarea(), { target: { value: "[[2026-08-15" } });
      fireEvent.click(screen.getByText("2026-08-15"));

      expect(getTextarea()).toHaveValue("[[2026-08-15]]");
    });

    it("does not offer an invalid calendar date", () => {
      render(<Composer onSend={vi.fn()} recentEntries={[]} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      fireEvent.change(getTextarea(), { target: { value: "[[2026-13-45" } });

      expect(screen.queryByText("2026-13-45")).not.toBeInTheDocument();
      expect(screen.getByText("No matching day")).toBeInTheDocument();
    });

    // Issue #144's own acceptance criterion: the reader never has to read
    // or type an Entry's id.
    it("choosing a searched Entry inserts [[e:<id>]], and its id is never shown as text in the list", async () => {
      const target = entry({ id: "target-entry-id", body: "a target entry" });
      const searchEntries = vi.fn(async () => [target]);
      render(<Composer onSend={vi.fn()} searchEntries={searchEntries} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      fireEvent.change(getTextarea(), { target: { value: "[[target" } });

      const option = await screen.findByText("a target entry");
      expect(screen.queryByText(target.id)).not.toBeInTheDocument();

      fireEvent.click(option);

      expect(getTextarea()).toHaveValue(`[[e:${target.id}]]`);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("searches with the typed text once it can no longer be a date", () => {
      const searchEntries = vi.fn(async () => []);
      render(<Composer onSend={vi.fn()} searchEntries={searchEntries} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      fireEvent.change(getTextarea(), { target: { value: "[[groceries" } });

      expect(searchEntries).toHaveBeenCalledWith("groceries");
    });

    it("moves the highlight with arrow keys", () => {
      stubOffset(0);
      const recentEntries = [
        entry({ id: "r1", createdAt: "2026-08-15T12:00:00.000Z" }),
        entry({ id: "r2", createdAt: "2026-08-16T12:00:00.000Z" }),
      ];
      render(<Composer onSend={vi.fn()} recentEntries={recentEntries} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveAttribute("aria-selected", "true");
      expect(options[1]).toHaveAttribute("aria-selected", "false");

      fireEvent.keyDown(getTextarea(), { key: "ArrowDown" });
      expect(options[0]).toHaveAttribute("aria-selected", "false");
      expect(options[1]).toHaveAttribute("aria-selected", "true");

      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      expect(options[0]).toHaveAttribute("aria-selected", "true");
      expect(options[1]).toHaveAttribute("aria-selected", "false");
    });

    it("Enter chooses the highlighted suggestion", () => {
      stubOffset(0);
      const recentEntries = [entry({ id: "r1", createdAt: "2026-08-15T12:00:00.000Z" })];
      render(<Composer onSend={vi.fn()} recentEntries={recentEntries} />);

      fireEvent.change(getTextarea(), { target: { value: "[[" } });
      fireEvent.keyDown(getTextarea(), { key: "Enter" });

      expect(getTextarea()).toHaveValue("[[2026-08-15]]");
    });

    // The one rule issue #144 treats as non-negotiable: the Send chord
    // still sends, list open or not.
    it("still sends on Cmd+Enter while the list is open", () => {
      const onSend = vi.fn();
      render(<Composer onSend={onSend} />);

      fireEvent.change(getTextarea(), { target: { value: "hello [[" } });
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });

      expect(onSend).toHaveBeenCalledWith("hello [[");
      expect(getTextarea()).toHaveValue("");
    });
  });
});
