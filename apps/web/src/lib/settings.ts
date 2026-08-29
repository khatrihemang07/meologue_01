/**
 * Device-local settings — theme, Accent, text size and the Server URL
 * (ADR 0008) — held in a Zustand store so every reader, component or not, sees the same value and
 * every write fans out to every subscriber immediately. Before this, Sync
 * state was read straight off `localStorage` during render with no
 * subscription, so the "not yet synced" marker and the "Sync is off" hint
 * only refreshed when something else happened to re-render them (ticket 36).
 *
 * Persisted as plain `localStorage` string keys, one per setting —
 * `meologue.theme`, `meologue.server-url`, and since #128
 * `meologue.accent` and `meologue.text-size` — not a single JSON blob under
 * Zustand's `persist` middleware, which writes the whole store under one
 * key. Three things depend on that format: the inline
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
const LIST_WIDTH_KEY = "meologue.list-width";
const ACCENT_KEY = "meologue.accent";
const TEXT_SIZE_KEY = "meologue.text-size";

/**
 * How wide the chat list pane is beside an open destination (ADR 0036), in
 * CSS pixels. A per-Device view preference, not synced state: a reader who
 * drags the divider on a laptop should see no effect on a phone, the same
 * category ADR 0019 put the reading column itself in.
 *
 * The clamp lives in CSS (`chat-shell-layout.tsx`) rather than here, so a
 * stored value that no longer fits the window is corrected by the layout
 * every render instead of being rewritten in storage the first time a
 * reader opens the app on a smaller screen.
 */
export const DEFAULT_LIST_WIDTH = 320;

export type Theme = "light" | "dark" | "system";

/**
 * The colour a reader's own Entries are tinted with (#128).
 *
 * A per-Device view preference, exactly like theme and the list width — it
 * is a property of how this Device draws History, not of the History
 * itself, so it is deliberately never Synced and never enters the glossary:
 * CONTEXT.md names what the app is *about*, and a tint is a view mechanic,
 * the same category ADR 0019 put the reading column in.
 *
 * Five named swatches rather than a colour picker, and the ids are all that
 * live here — `index.css` owns the five actual colours, keyed on
 * `[data-accent]`. That split is what lets `index.html`'s pre-paint script
 * apply a stored Accent by writing one attribute, without carrying a second
 * copy of five colours that would then have to be kept in step.
 */
export type AccentId = "green" | "teal" | "blue" | "violet" | "graphite";

export const ACCENTS: { id: AccentId; label: string }[] = [
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
  { id: "blue", label: "Blue" },
  { id: "violet", label: "Violet" },
  { id: "graphite", label: "Graphite" },
];

/**
 * Blue, not the neutral Graphite that would preserve exactly what the app
 * looked like before this setting existed. An outgoing bubble and an
 * incoming one were told apart by `bg-primary/10` against `bg-muted`, and
 * in the light theme those are both near-grey — on Composer that costs
 * nothing (every Entry is outgoing), but on Reflect it undercuts the whole
 * point of a two-sided thread. Shipping Graphite by default would leave
 * that defect in place for every reader who never opens Settings. Graphite
 * is still one press away for anyone who wants the neutral look back.
 */
export const DEFAULT_ACCENT: AccentId = "blue";

/**
 * How much bigger or smaller an Entry's own words are drawn (#128). Three
 * named steps, not a slider: the scales themselves live in `index.css`
 * under `[data-text-size]`, for the same reason the Accent colours do.
 */
export type TextSizeId = "small" | "default" | "large";

export const TEXT_SIZES: { id: TextSizeId; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
];

export const DEFAULT_TEXT_SIZE: TextSizeId = "default";

function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

function isTextSizeId(value: unknown): value is TextSizeId {
  return TEXT_SIZES.some((size) => size.id === value);
}

function readStoredAccent(): AccentId {
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    return isAccentId(stored) ? stored : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

function writeStoredAccent(accent: AccentId): void {
  try {
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    // Refused write — the choice applies for this session and is forgotten
    // on the next launch, the same degradation every other setting here has.
  }
}

function readStoredTextSize(): TextSizeId {
  try {
    const stored = localStorage.getItem(TEXT_SIZE_KEY);
    return isTextSizeId(stored) ? stored : DEFAULT_TEXT_SIZE;
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

function writeStoredTextSize(size: TextSizeId): void {
  try {
    localStorage.setItem(TEXT_SIZE_KEY, size);
  } catch {
    // As above.
  }
}

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

function readStoredListWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(LIST_WIDTH_KEY));
    // `Number("")` is 0 and `Number(null)` is 0, so a positive-and-finite
    // check covers a missing key, a cleared value and anything a different
    // version of this app might have written, without three separate guards.
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIST_WIDTH;
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

function writeStoredListWidth(width: number): void {
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(width));
  } catch {
    // Refused write — the in-memory value below still applies for this
    // session, only the memory of it across launches is lost.
  }
}

interface SettingsState {
  theme: Theme;
  accent: AccentId;
  textSize: TextSizeId;
  serverUrl: string;
  listWidth: number;
  setTheme: (theme: Theme) => void;
  setAccent: (accent: AccentId) => void;
  setTextSize: (size: TextSizeId) => void;
  setServerUrl: (url: string) => void;
  setListWidth: (width: number) => void;
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
  accent: readStoredAccent(),
  textSize: readStoredTextSize(),
  serverUrl: readStoredServerUrl(),
  listWidth: readStoredListWidth(),
  setTheme: (theme) => {
    writeStoredTheme(theme);
    set({ theme });
  },
  setAccent: (accent) => {
    writeStoredAccent(accent);
    set({ accent });
  },
  setTextSize: (textSize) => {
    writeStoredTextSize(textSize);
    set({ textSize });
  },
  setServerUrl: (url) => {
    const normalised = normaliseServerUrl(url);
    writeStoredServerUrl(normalised);
    set({ serverUrl: normalised });
  },
  setListWidth: (width) => {
    const rounded = Math.round(width);
    writeStoredListWidth(rounded);
    set({ listWidth: rounded });
  },
}));

/** ADR 0011: an empty Server URL means Sync is off. Re-renders when the Server URL changes. */
export function useSyncEnabled(): boolean {
  return useSettingsStore((state) => state.serverUrl !== "");
}
