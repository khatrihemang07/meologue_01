import { readTheme, type Theme } from "@/lib/settings";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function resolve(theme: Theme): "light" | "dark" {
  return theme === "system" ? (prefersDark() ? "dark" : "light") : theme;
}

/**
 * Toggles the `dark` class on the document root, switching index.css's
 * `.dark` palette on. index.css pairs `:root` and `.dark` each with their
 * own `color-scheme`, so this same toggle also carries scrollbars and
 * native form controls over — no separate style to set here.
 *
 * index.html runs the same resolution inline before first paint; this is
 * what keeps it applied as the theme changes afterwards.
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
