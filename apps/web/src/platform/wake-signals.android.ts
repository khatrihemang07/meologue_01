import { App } from "@capacitor/app";

/**
 * Android's implementation of the wake-signals seam (ticket 12), backed by
 * Capacitor's app-lifecycle events rather than DOM signals (ticket 14):
 * backgrounding a WebView doesn't reliably flip `document.visibilityState`,
 * and `window.online` frequently never fires at all. Connectivity changes
 * are deliberately not listened for — a failed poll just retries on the
 * next interval tick.
 *
 * Visible defaults to true: the app always launches in the foreground, and
 * `subscribeToWakeEvents` — wired up as soon as the app mounts — is what
 * keeps this current from then on.
 */
let visible = true;

export function isTabVisible(): boolean {
  return visible;
}

export function subscribeToWakeEvents(wake: () => void): () => void {
  const listenerHandle = App.addListener("appStateChange", ({ isActive }) => {
    visible = isActive;
    if (isActive) {
      wake();
    }
  });

  return () => {
    void listenerHandle.then((listener) => listener.remove());
  };
}
