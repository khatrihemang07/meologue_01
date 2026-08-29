import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SyncLoop } from "@/hooks/use-sync-loop";
import { queryClient } from "@/lib/query-client";
import { useSettingsStore } from "@/lib/settings";
import { applyAccent, applyTextSize, applyTheme, watchSystemTheme } from "@/lib/theme";
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

// index.html already applied all three of these inline, before the browser's
// first paint — this bundle is a deferred module and would otherwise run
// after the stylesheet had painted the light palette and the default Accent.
// Re-applying here keeps the whole resolution in one place for every later
// change, and costs one class toggle and two attribute writes.
const settings = useSettingsStore.getState();
applyTheme(settings.theme);
applyAccent(settings.accent);
applyTextSize(settings.textSize);
watchSystemTheme();

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
