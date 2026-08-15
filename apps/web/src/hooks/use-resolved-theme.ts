import { useEffect, useState } from "react";

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/**
 * Tracks the resolved light/dark theme by observing the `dark` class
 * `theme.ts`'s `applyTheme` toggles on `<html>` — the single source of
 * truth for what's currently applied, however it got there (a click on
 * Settings, `watchSystemTheme` reacting to an OS change, or the initial
 * apply in main.tsx). A `MutationObserver` keeps this decoupled from every
 * call site that can change the theme, rather than needing each of them to
 * also notify this hook.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [dark, setDark] = useState(isDark);

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return dark ? "dark" : "light";
}
