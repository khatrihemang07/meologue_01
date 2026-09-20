import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  onMultiLinePaste,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onMultiLinePaste?: (lines: string[]) => void;
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
    <>
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
      {/*
        The real editor's own `transformPasted` decides whether a paste is
        multi-line (task-title-editor.test.tsx's own suite covers THAT
        decision with a real DOM paste event, against the real component).
        This stub only needs to prove `onMultiLinePaste` reaches this
        editor at all — `add-task-form.tsx`'s own wiring — so it stands in
        with a plain button a test can click directly, the same "stub
        proves the prop reaches here" shape `onCommit`/`onCancel` above
        already use via Enter/Escape.
      */}
      {onMultiLinePaste !== undefined && (
        <button type="button" onClick={() => onMultiLinePaste(["Task A", "Task B", "Task C"])}>
          Simulate multi-line paste
        </button>
      )}
    </>
  );
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

/**
 * `task-schedule-popover.test.tsx`'s own `stubLayout` helper, mirrored:
 * `test/setup.ts`'s global stub already answers non-touch to every query,
 * so only the touch branch needs stubbing at all — a test with no call to
 * this exercises non-touch by construction, the same "assert the
 * property, not the difference" discipline that file's own header
 * comment names.
 */
function stubTouch(touch: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: touch && (query === "(pointer: coarse)" || query === "(hover: none)"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

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

  // `test/setup.ts`'s own header comment on `stubTouch`-shaped helpers:
  // clears a per-test `matchMedia` stub before the next `beforeEach`
  // re-installs the (non-touch) default, so a touch stub never leaks
  // into a test that never asked for it.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders collapsed, as a quiet 'Add task' button", async () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
  });

  // Issue #374: the submit control is absent from the DOM while the
  // title is empty, not disabled (`web/01-anatomy.md`/`android/02-
  // anatomy.md`'s own measured fact) — Cancel and "More actions" are the
  // two controls the empty-title tab order names as always present
  // (`web/01-anatomy.md`), so they render at rest; "Add task" does not.
  it("reveals the editor and Cancel at rest; Add task appears only once there's text", async () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
    await reveal();

    expect(await getInput()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });

    expect(await screen.findByRole("button", { name: "Add task" })).toBeInTheDocument();
  });

  it("calls onAdd with the parsed fields on Add, then collapses on non-touch", async () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);
    await reveal();

    const firstInput = await getInput();
    fireEvent.change(firstInput, { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk", date: null, priority: 1, labelNames: [] }),
    );
    expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
  });

  it("calls onAdd with the parsed fields on Enter, the editor's own commit keymap", async () => {
    const onAdd = vi.fn();
    // Issue #388: `@errands` only matches an existing Label — see
    // `use-quick-add-composer.test.ts`'s identical fixture change for the
    // full reasoning.
    render(
      <AddTaskForm onAdd={onAdd} disabled={false} labels={[{ id: "l1", name: "errands" }]} />,
    );
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

    const input = await getInput();
    fireEvent.change(input, { target: { value: "   " } });
    // Whitespace-only still reads as empty (`composer.value.trim()`) —
    // the submit control stays absent from the DOM, so this submits
    // through the editor's own commit keymap (Enter) instead of a click.
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

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

  it("Add task is absent from the DOM until there is non-blank text, never merely disabled", async () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
    await reveal();

    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();

    fireEvent.change(await getInput(), { target: { value: "buy milk" } });

    const submit = await screen.findByRole("button", { name: "Add task" });
    expect(submit).toBeInTheDocument();
    expect(submit).not.toBeDisabled();
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

  /**
   * Issue #373: the actual multi-line SPLIT/parse behaviour is tested in
   * `task-title-editor.test.tsx` (the real paste mechanics) and
   * `use-quick-add-composer.test.ts` (the real commit-per-line logic) —
   * both below `TaskTitleEditor`, which this file's own header comment
   * explains is deliberately mocked out here. This is the one link those
   * two don't cover: that `AddTaskForm` actually wires `onMultiLinePaste`
   * through to the editor and renders `MultiLinePasteDialog` fed by the
   * real `useQuickAddComposer` state, end to end.
   */
  describe("multi-line paste wiring", () => {
    it("a multi-line paste opens the confirmation dialog, and Split calls onAdd once per line", async () => {
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);
      await reveal();

      fireEvent.click(screen.getByRole("button", { name: "Simulate multi-line paste" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Add 3 tasks?")).toBeInTheDocument();
      expect(onAdd).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Add 3 tasks" }));

      expect(onAdd).toHaveBeenCalledTimes(3);
      expect(onAdd).toHaveBeenNthCalledWith(1, expect.objectContaining({ content: "Task A" }));
      expect(onAdd).toHaveBeenNthCalledWith(3, expect.objectContaining({ content: "Task C" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("Merge to single task calls onAdd once, with every line joined", async () => {
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);
      await reveal();

      fireEvent.click(screen.getByRole("button", { name: "Simulate multi-line paste" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Merge to single task" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Add task" }));

      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Task A Task B Task C" }),
      );
    });

    it("Cancel creates nothing", async () => {
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);
      await reveal();

      fireEvent.click(screen.getByRole("button", { name: "Simulate multi-line paste" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(onAdd).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  /**
   * Hard compatibility constraint (issue #374's own brief):
   * `apps/e2e/tests/todo.spec.ts`'s `addTask` helper locates
   * `[data-add-task-field]` once and expects both the collapsed trigger
   * and (after its own first click) the expanded editor to be found
   * inside it — unmodified by this ticket.
   */
  it("data-add-task-field marks both the collapsed row and the expanded card", async () => {
    const { container } = render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

    expect(container.querySelector("[data-add-task-field]")).toBeInTheDocument();
    await reveal();

    const marked = container.querySelector("[data-add-task-field]");
    expect(marked).toBeInTheDocument();
    expect(within(marked as HTMLElement).getByLabelText("Task name")).toBeInTheDocument();
  });

  describe("shell chosen by touch capability (issue #374/D4)", () => {
    it("touch renders the floating bottom card, still reachable through data-add-task-field", async () => {
      stubTouch(true);
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      await reveal();

      // Portalled to `document.body` (the touch sheet is a real Radix
      // `Dialog`), so it's found off `document`, not the render's own
      // `container` — the same reason `quick-add-dialog.test.tsx` already
      // queries `document.querySelector('[data-testid="quick-add"]')`.
      const marked = document.querySelector("[data-add-task-field]");
      expect(marked).toBeInTheDocument();
      expect(marked?.className).toContain("bottom-0");
      expect(marked?.className).toContain("rounded-[32px]");
      expect(within(marked as HTMLElement).getByLabelText("Task name")).toBeInTheDocument();
      // Touch drops the row-level Cancel button (`quick-add-content.tsx`'s
      // own header comment on D11's "no Cancel row" reading).
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    });

    it("touch stays open after Add and resets its Project chip to Inbox", async () => {
      stubTouch(true);
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} ambientProjectName="Groceries" />);
      await reveal();

      expect(screen.getByRole("button", { name: "Select project" })).toHaveTextContent("Inbox");
      fireEvent.change(await getInput(), { target: { value: "buy milk" } });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      expect(onAdd).toHaveBeenCalled();
      expect(await getInput()).toHaveValue("");
      expect(screen.getByRole("button", { name: "Select project" })).toHaveTextContent("Inbox");
      expect(screen.getByRole("button", { name: "Set date" })).toHaveTextContent("Date");
    });
  });
});
