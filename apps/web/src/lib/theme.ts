import { readTheme, type Theme } from "@/lib/settings";

// `.dark` and `@custom-variant dark (&:is(.dark *))` in index.css already
// carry a complete dark palette; nothing applies the class anywhere, so
// that half of the stylesheet has been dead code until this file.
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function resolve(theme: Theme): "light" | "dark" {
  return theme === "system" ? (prefersDark() ? "dark" : "light") : theme;
}

/**
 * Toggles the `dark` class on the document root. index.css pairs `:root`
 * and `.dark` each with their own `color-scheme`, so this same toggle also
 * carries scrollbars and native form controls over to the dark palette —
 * no separate style to set here.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", resolve(theme) === "dark");
}

/**
 * Keeps the app in step with the OS while "system" is selected. Reads the
 * *stored* theme on every change rather than closing over the value passed
 * at call time, since the whole point is to react to an OS change that can
 * happen long after this listener was registered — and to stay a no-op
 * once the user has since chosen an explicit light/dark.
 */
export function watchSystemTheme(): void {
  window.matchMedia(DARK_MEDIA_QUERY).addEventListener("change", () => {
    if (readTheme() === "system") {
      applyTheme("system");
    }
  });
}
