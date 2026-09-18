/**
 * The sandbox target runs in a real browser tab (ticket 12's fourth
 * target), so it reuses the web implementation of this seam unchanged
 * rather than duplicating it — the same reasoning `wake-signals.sandbox.ts`
 * already uses for its own seam.
 */
export { COMPLETION_TOAST_DURATION_MS } from "./completion-toast-duration.web";
