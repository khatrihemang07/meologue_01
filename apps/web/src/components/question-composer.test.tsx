import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { QuestionComposer } from "./question-composer";

function getTextarea() {
  return screen.getByPlaceholderText("Ask a Question about your History");
}

describe("QuestionComposer", () => {
  it("inserts a newline on plain Enter, without asking", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    const event = fireEvent.keyDown(getTextarea(), { key: "Enter" });

    expect(onAsk).not.toHaveBeenCalled();
    // preventDefault() was not called — the textarea's own default
    // behaviour (inserting a newline) was left alone.
    expect(event).toBe(true);
  });

  it("asks on Cmd+Enter and clears the textarea", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} />);

    fireEvent.change(getTextarea(), { target: { value: "what did I do today" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });

    expect(onAsk).toHaveBeenCalledWith("what did I do today", undefined);
    expect(getTextarea()).toHaveValue("");
  });

  it("asks on Ctrl+Enter (vitest's mode falls through to the desktop rule)", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} />);

    fireEvent.change(getTextarea(), { target: { value: "what did I do today" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", ctrlKey: true });

    expect(onAsk).toHaveBeenCalledWith("what did I do today", undefined);
  });

  it("does not ask on Shift+Enter even with a modifier also held", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true, shiftKey: true });

    expect(onAsk).not.toHaveBeenCalled();
  });

  it("does not ask whitespace-only input, on the chord or via the button", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} />);

    fireEvent.change(getTextarea(), { target: { value: "   " } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onAsk).not.toHaveBeenCalled();
  });

  it("asks when the Ask button is clicked", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onAsk).toHaveBeenCalledWith("hello", undefined);
  });

  it("disables the textarea and Ask button while disabled", () => {
    render(<QuestionComposer onAsk={vi.fn()} disabled />);

    expect(getTextarea()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });

  it("ignores the chord and the Ask button while disabled", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} disabled />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onAsk).not.toHaveBeenCalled();
  });

  // The regression the macOS drive found and every prior test missed. The
  // existing focus test passes a `vi.fn()` as `onAsk`, so `disabled` never
  // flips and the field never loses focus in the first place — it asserts a
  // state the real app does not reach. In the real app `onAsk` sets the
  // page's `pending`, this component re-renders `disabled`, and a disabled
  // element cannot hold focus: `AXFocusedUIElement` on the macOS build read
  // as the bare `AXWebArea` after Ask.
  //
  // jsdom does NOT itself blur an element when it becomes disabled, so the
  // blur is performed explicitly below — this test reproduces the browser's
  // behaviour rather than discovering it, and the assertion that matters is
  // the last one: the caret comes back when the field is usable again.
  it("returns the caret when the Turn lands, not only at the instant of asking", () => {
    const { rerender } = render(<QuestionComposer onAsk={vi.fn()} />);
    const field = getTextarea();

    fireEvent.change(field, { target: { value: "why did I start running" } });
    field.focus();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    // The page answers `onAsk` by setting `pending`, which disables this
    // field; a real browser drops focus to the document at that moment.
    // jsdom does not — it ignores `blur()` on a disabled element — so focus
    // is moved to a decoy explicitly. This is load-bearing rather than
    // scaffolding: without it focus would never leave the field, the final
    // assertion would hold for that reason alone, and the test would pass
    // just as happily with the fix deleted.
    rerender(<QuestionComposer onAsk={vi.fn()} disabled />);
    const decoy = document.createElement("input");
    document.body.append(decoy);
    decoy.focus();
    expect(document.activeElement).toBe(decoy);

    // The Turn lands, `pending` clears, and the caret must come back.
    rerender(<QuestionComposer onAsk={vi.fn()} />);
    expect(document.activeElement).toBe(getTextarea());
    decoy.remove();
  });

  // The guard on the effect above: a `disabled` transition this reader did
  // not cause — opening a Session whose Turn was already in flight — must
  // not pull focus into this field unasked.
  it("does not steal focus on a disabled transition the reader did not cause", () => {
    const { rerender } = render(<QuestionComposer onAsk={vi.fn()} disabled />);

    rerender(<QuestionComposer onAsk={vi.fn()} />);

    expect(document.activeElement).not.toBe(getTextarea());
  });

  it("does not show the send-chord hint", () => {
    render(<QuestionComposer onAsk={vi.fn()} />);

    expect(screen.queryByText("⌘↵ or Ctrl↵ to send")).not.toBeInTheDocument();
  });

  it("restores a failed Question's text when `restore.signal` changes", () => {
    const { rerender } = render(<QuestionComposer onAsk={vi.fn()} />);

    fireEvent.change(getTextarea(), { target: { value: "typed while asking" } });
    rerender(
      <QuestionComposer onAsk={vi.fn()} restore={{ question: "typed while asking", signal: 1 }} />,
    );

    expect(getTextarea()).toHaveValue("typed while asking");
  });
});

// Same "steals no caret" rule composer.tsx's own Send button follows
// (L574-587 there) — Reflect's Android build has the identical
// only-path-is-the-button shape (submit-chord.ts), so a tap on Ask that
// blurs the textarea closes the soft keyboard the same way an unguarded
// Send would.
describe("QuestionComposer's Ask button keeps focus on the field", () => {
  it("prevents the default mousedown action", () => {
    render(<QuestionComposer onAsk={vi.fn()} />);

    // See composer.test.tsx's identical assertion for why `false` is the
    // right expectation here: `fireEvent`'s return value is
    // `dispatchEvent`'s own, `false` once something called
    // `preventDefault()` on this cancelable event.
    const dispatchResult = fireEvent.mouseDown(screen.getByRole("button", { name: "Ask" }));

    expect(dispatchResult).toBe(false);
  });

  it("refocuses the textarea after asking, even if focus had already moved elsewhere", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} />);
    const field = getTextarea();

    fireEvent.change(field, { target: { value: "hello" } });
    // Sets up a state the refocus can actually be told apart from — without
    // this, clicking Ask in jsdom never moves focus onto the button in the
    // first place (jsdom does not implement a browser's implicit
    // mousedown-focuses-the-target default action for a plain `<button>`),
    // so the assertion below would pass whether or not `ask()` does
    // anything at all.
    field.blur();
    expect(document.activeElement).not.toBe(field);

    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onAsk).toHaveBeenCalledWith("hello", undefined);
    expect(document.activeElement).toBe(field);
  });
});

// Issue #98: the model picker. `models` is `undefined`/empty in every test
// above this point — those pin "the default case is unchanged" on their
// own: no picker renders, and `onAsk`'s second argument is always
// `undefined`, exactly what a Server that predates GET /v1/models (or one
// whose wrapper is unreachable) leaves this component with.
describe("QuestionComposer's model picker", () => {
  const models = [
    { id: "codex-terra", streaming: false, context_window: 272000 },
    { id: "claude-sonnet", streaming: true, context_window: 200000 },
  ];

  it("renders no picker at all when no models are offered", () => {
    render(<QuestionComposer onAsk={vi.fn()} />);
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("offers exactly the models the Server returned, plus Server default", () => {
    render(<QuestionComposer onAsk={vi.fn()} models={models} />);
    const picker = screen.getByLabelText("Model");
    const options = Array.from(picker.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["Server default", "codex-terra", "claude-sonnet"]);
  });

  it("asks with no model chosen when the picker is left on Server default", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} models={models} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onAsk).toHaveBeenCalledWith("hello", undefined);
  });

  it("asks with the chosen model's id once the picker is changed", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} models={models} />);

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet" } });
    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onAsk).toHaveBeenCalledWith("hello", "claude-sonnet");
  });

  it("points the picker at currentModel — an opened Conversation already on a chosen model", () => {
    render(<QuestionComposer onAsk={vi.fn()} models={models} currentModel="claude-sonnet" />);
    expect(screen.getByLabelText("Model")).toHaveValue("claude-sonnet");
  });

  it("re-points the picker when currentModel changes, e.g. opening a different Session", () => {
    const { rerender } = render(
      <QuestionComposer onAsk={vi.fn()} models={models} currentModel="claude-sonnet" />,
    );
    expect(screen.getByLabelText("Model")).toHaveValue("claude-sonnet");

    rerender(<QuestionComposer onAsk={vi.fn()} models={models} currentModel={undefined} />);
    expect(screen.getByLabelText("Model")).toHaveValue("");
  });
});

// Issue #202: a Device-local default that pre-selects this picker for a
// fresh Conversation, without making every ask sticky to it.
describe("QuestionComposer's default Reflect model", () => {
  const models = [
    { id: "codex-terra", streaming: false, context_window: 272000 },
    { id: "claude-sonnet", streaming: true, context_window: 200000 },
  ];

  afterEach(() => {
    // Settings is a real, module-scoped Zustand store (settings.ts), not a
    // mock — every test here has to leave it exactly as it found it, or a
    // later test in this file (or `settings-page.test.tsx`'s own default
    // state, if the suite ever shares a worker) inherits whichever value
    // ran last.
    useSettingsStore.setState({ defaultReflectModel: "" });
  });

  it("pre-selects the Device default on a fresh Conversation, with no currentModel yet", () => {
    useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });

    render(<QuestionComposer onAsk={vi.fn()} models={models} />);

    expect(screen.getByLabelText("Model")).toHaveValue("claude-sonnet");
  });

  it("asks on the Device default when the picker is left untouched", () => {
    useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });
    const onAsk = vi.fn();
    render(<QuestionComposer onAsk={onAsk} models={models} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onAsk).toHaveBeenCalledWith("hello", "claude-sonnet");
  });

  it("lets a Conversation's own currentModel win over the Device default", () => {
    useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });

    render(<QuestionComposer onAsk={vi.fn()} models={models} currentModel="codex-terra" />);

    expect(screen.getByLabelText("Model")).toHaveValue("codex-terra");
  });

  it("still shows Server default with no Device default stored, exactly as before this ticket", () => {
    render(<QuestionComposer onAsk={vi.fn()} models={models} />);

    expect(screen.getByLabelText("Model")).toHaveValue("");
  });

  it("re-points a brand-new Conversation at the Device default, not at what the last one had picked", () => {
    useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });
    const { rerender } = render(
      <QuestionComposer onAsk={vi.fn()} models={models} currentModel="codex-terra" />,
    );
    expect(screen.getByLabelText("Model")).toHaveValue("codex-terra");

    rerender(<QuestionComposer onAsk={vi.fn()} models={models} currentModel={undefined} />);

    expect(screen.getByLabelText("Model")).toHaveValue("claude-sonnet");
  });
});
