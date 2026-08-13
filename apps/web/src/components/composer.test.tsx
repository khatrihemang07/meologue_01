import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

function getTextarea() {
  return screen.getByPlaceholderText("What's on your mind?");
}

describe("Composer", () => {
  it("sends on Enter and clears the textarea", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("hello");
    expect(getTextarea()).toHaveValue("");
  });

  it("does not send on Shift+Enter, leaving the default newline behavior alone", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    const event = fireEvent.keyDown(getTextarea(), { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(event).toBe(true); // preventDefault() was not called
  });

  it("does not send whitespace-only input, on Enter or via the button", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.change(getTextarea(), { target: { value: "   " } });
    fireEvent.keyDown(getTextarea(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).not.toHaveBeenCalled();
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

  it("ignores Enter and the Send button while disabled", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled />);

    fireEvent.change(getTextarea(), { target: { value: "hello" } });
    fireEvent.keyDown(getTextarea(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).not.toHaveBeenCalled();
  });
});
