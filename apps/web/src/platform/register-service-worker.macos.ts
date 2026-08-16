/**
 * The macOS shell is a WKWebView, same reasoning as Android's no-op
 * (register-service-worker.android.ts, ticket 45) — reused rather than
 * duplicated.
 */
export { registerServiceWorker } from "./register-service-worker.android";
