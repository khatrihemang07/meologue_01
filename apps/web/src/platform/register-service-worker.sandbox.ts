/**
 * The sandbox target runs in a real browser but deliberately gets no
 * service worker (vite.config.ts's `target === "web"` gate excludes it) —
 * a stale SW cache would silently serve an old shell and make a good build
 * look broken, exactly the failure mode this target exists to rule out.
 * Reuses the no-op registration shared by Android and macOS
 * (register-service-worker.macos.ts, ticket 45) rather than duplicating it.
 */
export { registerServiceWorker } from "./register-service-worker.macos";
