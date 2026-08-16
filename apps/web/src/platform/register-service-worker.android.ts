/**
 * Android's WebView is not a browser tab — nothing there ever shows an
 * install prompt or applies a service worker's caching, and vite.config.ts
 * never runs the VitePWA plugin for this target in the first place (ticket
 * 45), so there is no `virtual:pwa-register` module to import even if this
 * called it. This file exists only so the register-service-worker seam
 * (ADR 0005) has one implementation per target; it does nothing.
 */
export function registerServiceWorker(): void {}
