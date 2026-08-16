import { registerSW } from "virtual:pwa-register";
import { toast } from "sonner";

/**
 * The web implementation of the register-service-worker seam (ticket 45).
 * `registerType: "prompt"` in vite.config.ts's VitePWA plugin means a new
 * service worker parks itself "waiting" instead of taking over immediately
 * — `onNeedRefresh` fires once that happens, and this raises a toast rather
 * than reloading on its own. Deploying isn't rare here (this is a personal
 * app the developer rebuilds constantly), and the one thing on screen is a
 * composer that may hold a half-typed Entry; an automatic reload would
 * discard it without warning. `updateSW(true)` both tells the waiting
 * worker to activate and reloads the page for it, so accepting the toast is
 * the only path that yields a fresh app shell.
 *
 * The toast has no timeout — closing it without choosing "Reload" is the
 * same as never having seen it, and the new version stays queued for the
 * next natural reload either way.
 */
export function registerServiceWorker(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      toast("A new version of meologue is available.", {
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Reload",
          onClick: () => {
            void updateSW(true);
          },
        },
      });
    },
  });
}
