import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
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
 */
function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  return (
    <input
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

/**
 * Issue #260: the field is collapsed by default (NAV-12) — every test
 * below has to click the resting "Add task" button before it can reach
 * the editor at all, mirroring what a real reader (and `apps/e2e/tests/
 * todo.spec.ts`'s own updated `addTask` helper) now has to do too.
 */
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

  it("calls onAdd with the parsed fields on Add, and collapses back to the quiet row", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk", date: null, priority: 1, labelNames: [] }),
    );
    // NAV-12/QA-19 (parity ledger): a real Add collapses the composer back
    // to the quiet trigger row, matching Todoist's own click-to-reveal
    // affordance rather than keeping it open for another task — this
    // file's own header comment records why that call was made.
    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
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
});
