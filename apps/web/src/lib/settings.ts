/**
 * Device-local settings — theme and the Server URL (ADR 0008) — held in a
 * Zustand store so every reader, component or not, sees the same value and
 * every write fans out to every subscriber immediately. Before this, Sync
 * state was read straight off `localStorage` during render with no
 * subscription, so the "not yet synced" marker and the "Sync is off" hint
 * only refreshed when something else happened to re-render them (ticket 36).
 *
 * Persisted as the same two plain `localStorage` string keys as before —
 * `meologue.theme`, `meologue.server-url` — not a single JSON blob under
 * Zustand's `persist` middleware, which writes the whole store under one
 * key. Three things depend on the two-plain-keys format: the inline
 * blocking script in `index.html` that applies the theme before first paint
 * and must never throw, the Playwright suite (`apps/e2e/tests/helpers.ts`),
 * which seeds the Server URL as a plain string, and every already-installed
 * Android and macOS app, which would silently lose its Server URL — and
 * therefore turn Sync off — on upgrade. So persistence here is hand-written
 * inside the store's own actions instead of delegated to that middleware.
 *
 * Every localStorage access is wrapped in try/catch and degrades to a
 * default rather than throwing — it throws on write in Safari private
 * browsing (and can throw on read too, e.g. a security exception in some
 * embedding contexts), and this app already models that world for the
 * Entry store (`src/lib/entry-store-errors.ts`'s `StorageUnavailableError`).
 * Settings must keep working under the same conditions, since it's also
 * where a bad Server URL gets fixed.
 */
import { create } from "zustand";

const THEME_KEY = "meologue.theme";
const SERVER_URL_KEY = "meologue.server-url";

export type Theme = "light" | "dark" | "system";

function readStoredTheme(): Theme {
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

function writeStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage refused the write (e.g. private browsing) — the store's
    // in-memory state still updates below, only persistence is lost.
  }
}

function readStoredServerUrl(): string {
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

function writeStoredServerUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_URL_KEY, url);
  } catch {
    // Refused write — sync keeps using whatever value the store already
    // holds in memory.
  }
}

interface SettingsState {
  theme: Theme;
  serverUrl: string;
  setTheme: (theme: Theme) => void;
  setServerUrl: (url: string) => void;
}

/**
 * Initial state is read from storage once, at module load — the same
 * degrade-to-default behaviour the old per-call helpers had, just run once
 * instead of on every call. Every later read (in or outside a component)
 * goes through this store rather than back to `localStorage`, and every
 * write here — from Settings, the only writer in the app — both persists
 * and updates this state synchronously, so `getState()` is never stale.
 */
export const useSettingsStore = create<SettingsState>()((set) => ({
  theme: readStoredTheme(),
  serverUrl: readStoredServerUrl(),
  setTheme: (theme) => {
    writeStoredTheme(theme);
    set({ theme });
  },
  setServerUrl: (url) => {
    const normalised = normaliseServerUrl(url);
    writeStoredServerUrl(normalised);
    set({ serverUrl: normalised });
  },
}));

/**
 * ADR 0011: an empty Server URL means Sync is off. Reads the store's
 * current state directly rather than as a hook — for callers outside a
 * component (the sync loop in `use-history.ts`, `sync-transport.ts`) that
 * need the latest value without subscribing to it.
 */
export function isSyncEnabled(): boolean {
  return useSettingsStore.getState().serverUrl !== "";
}

/** Reactive form of `isSyncEnabled` for components — re-renders when the Server URL changes. */
export function useSyncEnabled(): boolean {
  return useSettingsStore((state) => state.serverUrl !== "");
}
