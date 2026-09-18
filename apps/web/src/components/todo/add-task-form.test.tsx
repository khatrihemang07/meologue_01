import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { focusAddTaskField } from "@/lib/todo-keymap";
import { AddTaskForm } from "./add-task-form";

/**
 * Stands in for the real `TaskTitleEditor` — task-title-editor.tsx's own
 * header comment explains why no test mounts that component directly (it
 * wraps a real ProseMirror `EditorView`, which jsdom cannot usefully
 * mount, let alone type into or drive Backspace against). `task-detail-
 * view.test.tsx` and `task-row.test.tsx` mock the identical module the
 * identical way, for the identical reason.
 *
 * This means the recognition plugin — the actual subject of issue #226's
 * two-step Backspace withdrawal — is entirely untested here. That plugin
 * gets its own coverage two ways: `todo-quick-add-recognition.test.ts`
 * exercises the pure diff/parse logic directly (no DOM at all), and the
 * two-step Backspace's own on-screen behaviour (a real `EditorView`,
 * Backspace actually landing, the span's own two visual states) has not
 * been verified in a real browser as part of this change — see this
 * ticket's own report.
 *
 * `autoFocus` is honoured here too, the identical way `task-detail-
 * view.test.tsx`'s own `StubTaskTitleEditor` honours it — issue #260's
 * Defect 1/2 tests below need this stub to actually move focus, the same
 * real thing the ProseMirror editor's own mount-time `view.focus()` does
 * for `autoFocus={true}` (`add-task-form.tsx` always passes that).
 */
function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
  placeholder,
  autoFocus = true,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, mirroring the real editor's own mount-time focus.
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, []);
  return (
    <input
      ref={ref}
      aria-label={ariaLabel ?? "Task name"}
      placeholder={placeholder}
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
  );
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

async function reveal(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
}

async function getInput(): Promise<HTMLInputElement> {
  // `LazyTaskTitleEditor` wraps the (mocked) editor in `React.lazy` —
  // still an async boundary in tests even though the mock resolves
  // immediately, hence `findBy` rather than `getBy` — the same await
  // `task-row.test.tsx`/`task-detail-view.test.tsx` need for their own
  // lazy-loaded title editors.
  return (await screen.findByLabelText("Task name")) as HTMLInputElement;
}

describe("AddTaskForm", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ smartDatesEnabled: true });
  });

  it("renders collapsed, as a quiet 'Add task' button", async () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
  });

  it("reveals the editor and its Cancel/Add task buttons on click", async () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
    await reveal();

    expect(await getInput()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
  });

  it("calls onAdd with the parsed fields on Add, and stays open, empty and focused", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    const firstInput = await getInput();
    fireEvent.change(firstInput, { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk", date: null, priority: 1, labelNames: [] }),
    );
    const secondInput = await getInput();
    expect(secondInput).not.toBe(firstInput);
    expect(secondInput).toHaveValue("");
    expect(secondInput).toHaveFocus();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("calls onAdd with the parsed fields on Enter, the editor's own commit keymap", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    const input = await getInput();
    fireEvent.change(input, { target: { value: "buy milk @errands" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk", labelNames: ["errands"] }),
    );
  });

  it("does not call onAdd for blank input, and stays open", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    fireEvent.change(await getInput(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(await getInput()).toBeInTheDocument();
  });

  it("does not call onAdd for a line that parses to nothing but recognised tokens", async () => {
    // "tomorrow" alone strips entirely into `date`, leaving no `content` —
    // silently doing nothing here mirrors use-tasks.ts's own
    // addTask/renameTask, both of which already treat trimmed-empty
    // content as "nothing to add."
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    fireEvent.change(await getInput(), { target: { value: "tomorrow" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("Cancel collapses the composer back to the quiet row without adding anything", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
  });

  it("Escape (the editor's own onCancel) collapses the composer back to the quiet row", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    const input = await getInput();
    fireEvent.change(input, { target: { value: "buy milk" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onAdd).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
  });

  it("disables the field and button while the store isn't ready", async () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={true} />);

    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
  });

  it("disables the Add task button until there is non-blank text", async () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
    await reveal();

    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });

    expect(screen.getByRole("button", { name: "Add task" })).not.toBeDisabled();
  });

  it("submits a recognised recurrence phrase as dateString, stripped from content", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    fireEvent.change(await getInput(), { target: { value: "water the plants every day" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "water the plants", dateString: "every day" }),
    );
  });

  it("honours smartDatesEnabled: off leaves eager natural-language words as plain content", async () => {
    useSettingsStore.setState({ smartDatesEnabled: false });
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    fireEvent.change(await getInput(), { target: { value: "buy milk tomorrow p1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk tomorrow", priority: 4 }),
    );
  });

  /**
   * Issue #260 Defect 2: `todo-keymap.ts`'s `focusAddTaskField()` (the `A`
   * shortcut's own implementation) used to query
   * `[data-add-task-field] [role="textbox"], [data-add-task-field]
   * input:not([disabled])` directly against the DOM, and was a silent
   * no-op once this component's collapsed resting row — a bare
   * `<button>`, not a textbox or input — became the default. The
   * existing `A`-key tests in `use-todo-keymap.test.tsx` (L448-460) and
   * `todo-keymap.test.ts` (L148-165) both hand-build a fake
   * `<div data-add-task-field><div role="textbox">` that this real
   * collapsed component never renders — exactly why that defect shipped
   * under a fully green suite. These two tests call the real
   * `focusAddTaskField()` against a real, unmocked-at-the-DOM-level
   * `AddTaskForm` instead, so they would have caught it.
   */
  describe("focusAddTaskField (the `A` shortcut)", () => {
    it("reveals the real collapsed composer and focuses its editor", async () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();

      act(() => {
        focusAddTaskField();
      });

      const input = await getInput();
      expect(input).toHaveFocus();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    it("focuses an already-open composer without collapsing or clearing typed text", async () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      await reveal();

      const input = await getInput();
      fireEvent.change(input, { target: { value: "buy milk" } });
      input.blur();
      expect(input).not.toHaveFocus();

      act(() => {
        focusAddTaskField();
      });

      // Same element, still open, still holding what was typed — the
      // fast path in `focusAddTaskField()` finds this live input
      // directly and focuses it, never dispatching `FOCUS_ADD_TASK_EVENT`
      // (which would otherwise be indistinguishable, from this
      // component's side, from a fresh reveal).
      expect(await getInput()).toBe(input);
      expect(input).toHaveFocus();
      expect(input).toHaveValue("buy milk");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });
  });
});
