import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { readTheme } from "@/lib/settings";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import "./index.css";
import App from "./App.tsx";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

// Applied before the first render, not inside a component, so the `dark`
// class is already on <html> for React's first paint — localStorage is
// synchronous, so there is no flash of the wrong theme to correct later.
applyTheme(readTheme());
watchSystemTheme();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
