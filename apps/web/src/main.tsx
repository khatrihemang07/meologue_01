import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "@/lib/query-client";
import { readTheme } from "@/lib/settings";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import "./index.css";
import App from "./App.tsx";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

// index.html already applied the theme inline, before the browser's first
// paint — this bundle is a deferred module and would otherwise run after the
// stylesheet had painted the light palette. Re-applying here keeps the whole
// resolution in one place for every later change, and costs one class toggle.
applyTheme(readTheme());
watchSystemTheme();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
