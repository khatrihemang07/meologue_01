/**
 * The macOS shell is a WKWebView with real `visibilitychange`/`focus`/`online`
 * events, so it reuses the web implementation of the wake-signals seam
 * (ticket 12) unchanged rather than duplicating it.
 */
export { isTabVisible, subscribeToWakeEvents } from "./wake-signals.web";
