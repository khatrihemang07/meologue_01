import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
