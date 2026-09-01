import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SyncLoop } from "@/hooks/use-sync-loop";
import { queryClient } from "@/lib/query-client";
import { refreshCapabilities, useSettingsStore } from "@/lib/settings";
import {
  applyAccent,
  applyCompletedStyle,
  applyTextSize,
  applyTheme,
  watchSystemTheme,
} from "@/lib/theme";
import { registerServiceWorker } from "@/platform/register-service-worker";
import "./index.css";
import App from "./App.tsx";

// Only the web target's implementation of this seam does anything (ticket
// 45) — Android and macOS resolve to a no-op at build time (ADR 0005), so
// this call is unconditional here rather than gated on a runtime platform
// check.
registerServiceWorker();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

// index.html already applied the first three of these inline, before the
// browser's first paint — this bundle is a deferred module and would
// otherwise run after the stylesheet had painted the light palette and the
// default Accent. Re-applying here keeps the whole resolution in one place
// for every later change, and costs one class toggle and three attribute
// writes.
//
// `applyCompletedStyle` (issue #163) is deliberately NOT in index.html's
// pre-paint script, and it is the one setting here that does not need to be.
// The other three dress surfaces that exist in the very first frame: the
// page background, the accent, the base type scale. A completed checklist
// item cannot be on screen until the Entry store has opened and History has
// rendered, both of which are many frames after this line runs — so there is
// no window in which the wrong decoration could be painted and then
// corrected. It still has to run HERE, though: without it the stored
// preference would only ever take effect at the moment it was changed on the
// Settings page, and would be silently ignored on every subsequent start.
const settings = useSettingsStore.getState();
applyTheme(settings.theme);
applyAccent(settings.accent);
applyTextSize(settings.textSize);
applyCompletedStyle(settings.completedStyle);
watchSystemTheme();

// Issue #133: learns what the configured Server can actually serve, after
// the first paint rather than before it — `chat-list.tsx`'s
// `useDestinations()` already has a synchronous, optimistic answer from the
// cache this refreshes (`settings.ts`'s own doc comment), so nothing on
// this first render is waiting on the result. The double
// `requestAnimationFrame` is the same "earliest point a frame has actually
// been painted" trick `use-wide-layout.ts` uses, applied here to a network
// call instead of a layout read.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    refreshCapabilities();
  });
});

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Mounted above the router (ticket 38) so the Sync loop keeps
          running while the user is on Settings — a sibling route outside
          App's EntryStoreLayout (ADR 0008/0009). See use-sync-loop.ts. */}
      <SyncLoop />
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
