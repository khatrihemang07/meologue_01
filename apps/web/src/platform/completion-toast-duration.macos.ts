/**
 * The macOS shell is a pointer-driven WKWebView, not a touch surface like
 * Android's — issue #356 splits this figure by measured platform behaviour,
 * not by "is this a WebView", so macOS reuses the web target's measured
 * value (`completion-toast-duration.web.ts`) unchanged rather than
 * duplicating it, the same reasoning `wake-signals.macos.ts` already uses
 * for its own seam.
 */
export { COMPLETION_TOAST_DURATION_MS } from "./completion-toast-duration.web";
