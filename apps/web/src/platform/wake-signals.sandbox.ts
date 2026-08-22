/**
 * The sandbox target runs in a real browser tab (ticket 12's fourth target),
 * so it reuses the web implementation of the wake-signals seam unchanged
 * rather than duplicating it.
 */
export { isTabVisible, subscribeToWakeEvents } from "./wake-signals.web";
