/**
 * The web implementation of the back-button seam (issue #189): the browser
 * chrome already drives `window.history` (and, for a Radix-built
 * dialog/sheet/menu, a real Escape keypress) directly, so there is nothing
 * for this app to wire up itself. `canGoBack` is accepted, unused, purely
 * to keep this a drop-in replacement for `back-button.android.ts` (ADR
 * 0005's platform seam) — see that module's header comment for the
 * platform that does need it, and why it's a function rather than a value.
 */
export function subscribeToBackButton(_canGoBack: () => boolean): () => void {
  return () => {};
}
