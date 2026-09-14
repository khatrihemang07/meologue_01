/**
 * jsdom reports `0` for every layout read, so it cannot prove the thing this
 * hook exists for — that a field grows with its content. What it CAN prove is
 * the arithmetic and the guards, by standing a fake `scrollHeight` on the node:
 * that the box is collapsed before it is measured (without which the field is a
 * one-way ratchet that never shrinks again), that the cap is honoured, that
 * internal scrolling only switches on past the cap, and that a node with no
 * layout at all is left alone rather than pinned to `0px`.
 *
 * The real behaviour was measured on the device instead, and is recorded in
 * this hook's own header comment.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAutoGrowTextarea } from "./use-auto-grow-textarea";

/** A textarea whose `scrollHeight` answers with the current content height whenever the inline height is collapsed, and with the larger of content and box otherwise — the shape a real browser has, and the reason the hook must collapse before it measures. `setContent` lets a test change what the content needs, the way typing or deleting would. */
function textareaReporting(initial: number): {
  node: HTMLTextAreaElement;
  setContent: (next: number) => void;
} {
  const node = document.createElement("textarea");
  let content = initial;
  Object.defineProperty(node, "scrollHeight", {
    get(): number {
      const set = node.style.height;
      if (set === "" || set === "auto") {
        return content;
      }
      return Math.max(content, Number.parseFloat(set));
    },
  });
  return { node, setContent: (next) => (content = next) };
}

function render(node: HTMLTextAreaElement, value: string, maxHeight: number) {
  return renderHook(({ v }) => useAutoGrowTextarea({ current: node }, v, { maxHeight }), {
    initialProps: { v: value },
  });
}

describe("useAutoGrowTextarea", () => {
  it("sizes the field to its content", () => {
    const { node } = textareaReporting(84);
    render(node, "some text", 200);
    expect(node.style.height).toBe("84px");
  });

  it("stops at the cap and scrolls internally from there", () => {
    const { node } = textareaReporting(1016);
    render(node, "a very long comment", 200);
    expect(node.style.height).toBe("200px");
    expect(node.style.overflowY).toBe("auto");
  });

  it("does not scroll internally while it still fits", () => {
    const { node } = textareaReporting(84);
    render(node, "some text", 200);
    expect(node.style.overflowY).toBe("hidden");
  });

  // The regression the "collapse first" line exists for: without it,
  // `scrollHeight` reports the current box, so the field can only ever grow.
  it("shrinks again when the content shrinks", () => {
    const { node, setContent } = textareaReporting(400);
    const { rerender } = render(node, "long", 1000);
    expect(node.style.height).toBe("400px");

    setContent(40);
    rerender({ v: "short" });

    expect(node.style.height).toBe("40px");
  });

  it("leaves a field with no layout alone rather than pinning it to 0px", () => {
    const { node } = textareaReporting(0);
    render(node, "text", 200);
    expect(node.style.height).toBe("");
  });
});
