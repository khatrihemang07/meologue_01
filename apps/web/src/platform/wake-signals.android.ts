/**
 * Placeholder Android implementation of the wake-signals seam (ticket 12).
 * The Android WebView doesn't expose the DOM visibility/focus/online events
 * this seam is built around, so a real implementation (likely bridging
 * lifecycle callbacks from native code) arrives with the Android ticket.
 * Until then: always visible, never wakes on its own — the interval in
 * @meologue/core's scheduler is what keeps sync running.
 */
export function isTabVisible(): boolean {
  return true;
}

export function subscribeToWakeEvents(_wake: () => void): () => void {
  return () => {};
}
