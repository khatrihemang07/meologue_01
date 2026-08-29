/**
 * Copying text to the system clipboard, and saying honestly whether it
 * worked.
 *
 * Three engines run this app and they do not agree about the clipboard.
 * Chromium on a phone grants `navigator.clipboard.writeText` inside a user
 * gesture; a WKWebView served from Tauri's own custom scheme may not expose
 * `navigator.clipboard` at all, because the API is gated on a secure context
 * and a custom scheme is not one. So the async API is tried first and the
 * ancient `document.execCommand("copy")` is the fallback rather than the
 * other way round — and if both refuse, that is reported as a failure rather
 * than swallowed, because a clipboard the WebView refused must not look
 * identical to one that succeeded.
 */

/**
 * The `execCommand` path: a textarea, off-screen but focusable and selectable,
 * because `execCommand("copy")` copies the current selection and there is no
 * way to hand it a string directly. Deliberately not `display: none` or
 * `hidden` — neither can hold a selection.
 */
function copyViaExecCommand(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  // `fixed` with a zero-ish box keeps the page from scrolling to it, which a
  // focus on an element positioned far off the document would otherwise do.
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.width = "1px";
  field.style.height = "1px";
  field.style.opacity = "0";
  document.body.appendChild(field);
  const previous = document.activeElement;
  try {
    field.focus();
    field.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    // The reader was very likely mid-thread with the Composer focused; taking
    // focus away and not giving it back would close the soft keyboard under
    // them.
    if (previous instanceof HTMLElement) previous.focus();
  }
}

/** True when the text reached the clipboard, false when nothing did. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Rejected — a denied permission, a non-secure context, or a WebView
    // that exposes the API and refuses it. Fall through rather than give up:
    // the legacy path is not gated on any of those.
  }
  return copyViaExecCommand(text);
}
