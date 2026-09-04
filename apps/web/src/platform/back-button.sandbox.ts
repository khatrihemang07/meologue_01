/**
 * The sandbox target runs in a real browser tab, so it reuses the web
 * implementation of the back-button seam unchanged rather than duplicating
 * a no-op.
 */
export { subscribeToBackButton } from "./back-button.web";
