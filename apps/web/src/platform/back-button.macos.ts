/**
 * The macOS shell already has a working "go back" gesture of its own (issue
 * #189's own report), so, like `wake-signals.macos.ts`, this reuses the web
 * implementation of the back-button seam unchanged rather than duplicating
 * a no-op.
 */
export { subscribeToBackButton } from "./back-button.web";
