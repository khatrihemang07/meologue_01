/**
 * Device-local settings — theme and the runtime Server URL override (ADR
 * 0008). Deliberately two plain `localStorage` string keys rather than one
 * JSON blob under a schema: each setting is read and written independently,
 * and there's no shared shape between them worth coupling with a parse
 * step that can fail on both at once.
 *
 * Every access is wrapped in try/catch and degrades to the default rather
 * than throwing — `localStorage` throws on write in Safari private
 * browsing (and can throw on read too, e.g. a security exception in some
 * embedding contexts), and this app already models that world for the
 * Entry store (`src/lib/entry-store-errors.ts`'s `StorageUnavailableError`).
 * Settings must keep working under the same conditions, since it's also
 * where a bad Server URL gets fixed.
 */

const THEME_KEY = "meologue.theme";
const SERVER_URL_KEY = "meologue.server-url";

export type Theme = "light" | "dark" | "system";

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
    return "system";
  } catch {
    return "system";
  }
}

export function writeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage refused the write (e.g. private browsing) — the in-memory
    // effect (applyTheme) still ran, only persistence is lost.
  }
}

export function readServerUrl(): string {
  try {
    return localStorage.getItem(SERVER_URL_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Exported so the Settings page can show the user exactly what was stored
 * without reading it back — a read-back would return the *previous* value
 * when the write was refused, silently blanking what they typed.
 */
export function normaliseServerUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

export function writeServerUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_URL_KEY, normaliseServerUrl(url));
  } catch {
    // Refused write — sync keeps using whatever value it last read.
  }
}

/**
 * The address a Server URL setting actually resolves to (ADR 0008): the
 * stored override if one is set, else the build-time `VITE_SERVER_URL`,
 * else empty — same-origin, asking nothing extra of the request. Shared by
 * `sync-transport.ts` and `server-check.ts` so a reachability check always
 * asks about the same address sync would actually use.
 */
export function resolveServerUrl(url: string): string {
  return url || import.meta.env.VITE_SERVER_URL || "";
}
