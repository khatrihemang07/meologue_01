import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "execCommand");
});

/**
 * `navigator.clipboard` is a getter with no setter in jsdom, so it is
 * redefined rather than assigned — the same shape a real engine presents,
 * including the "the property is not there at all" case a WKWebView served
 * from a custom scheme actually produces.
 */
function stubClipboard(clipboard: unknown) {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

function stubExecCommand(result: boolean | (() => boolean)) {
  const spy = vi.fn(() => (typeof result === "function" ? result() : result));
  Object.defineProperty(document, "execCommand", { value: spy, configurable: true });
  return spy;
}

describe("copyText", () => {
  it("uses the async clipboard when the engine offers one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const execCommand = stubExecCommand(true);

    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    // The fallback is a fallback, not a belt-and-braces second write: a
    // second copy would clobber the first on engines where both work.
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the API is absent entirely", async () => {
    // A WKWebView on a custom scheme is not a secure context, and
    // `navigator.clipboard` is gated on one — so this is the shape Tauri's
    // macOS build actually presents, not a hypothetical.
    stubClipboard(undefined);
    const execCommand = stubExecCommand(true);

    expect(await copyText("hello")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when the API is present and rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    stubClipboard({ writeText });
    const execCommand = stubExecCommand(true);

    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when both paths refuse", async () => {
    // The property this whole module exists for: a clipboard the WebView
    // refused must not be indistinguishable from one that was written to.
    stubClipboard(undefined);
    stubExecCommand(false);

    expect(await copyText("hello")).toBe(false);
  });

  it("reports failure when execCommand throws rather than returning false", async () => {
    stubClipboard(undefined);
    stubExecCommand(() => {
      throw new Error("no");
    });

    expect(await copyText("hello")).toBe(false);
  });

  it("leaves no textarea behind, and gives focus back to whatever had it", async () => {
    // The reader is very likely mid-thread with the Composer focused; taking
    // focus and not returning it closes the soft keyboard under them.
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    stubClipboard(undefined);
    stubExecCommand(true);

    await copyText("hello");

    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("hands the fallback the exact text, not a trimmed or re-encoded version", async () => {
    stubClipboard(undefined);
    let copied: string | undefined;
    Object.defineProperty(document, "execCommand", {
      value: () => {
        copied = (document.activeElement as HTMLTextAreaElement | null)?.value;
        return true;
      },
      configurable: true,
    });

    const body = "  two   spaces\nand a newline  ";
    expect(await copyText(body)).toBe(true);
    expect(copied).toBe(body);
  });
});
