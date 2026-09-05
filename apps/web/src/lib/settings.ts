/**
 * Device-local settings — theme, Accent, text size and the Server URL
 * (ADR 0008) — held in a Zustand store so every reader, component or not, sees the same value and
 * every write fans out to every subscriber immediately. Before this, Sync
 * state was read straight off `localStorage` during render with no
 * subscription, so the "not yet synced" marker and the "Sync is off" hint
 * only refreshed when something else happened to re-render them (ticket 36).
 *
 * Persisted as plain `localStorage` string keys, one per setting —
 * `meologue.theme`, `meologue.server-url`, since #128 `meologue.accent` and
 * `meologue.text-size`, and since #134 `meologue.hidden-destinations` — not
 * a single JSON blob under
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
import type { ServerCapabilities } from "@meologue/core";
import { create } from "zustand";
import { checkServerUrl } from "@/lib/server-check";

const THEME_KEY = "meologue.theme";
const SERVER_URL_KEY = "meologue.server-url";
const LIST_WIDTH_KEY = "meologue.list-width";
const ACCENT_KEY = "meologue.accent";
const TEXT_SIZE_KEY = "meologue.text-size";
const COMPLETED_STYLE_KEY = "meologue.completed-style";
const FORMAT_BAR_VISIBLE_KEY = "meologue.format-bar-visible";
const SMART_DATES_ENABLED_KEY = "meologue.smart-dates-enabled";
const DEFAULT_REFLECT_MODEL_KEY = "meologue.default-reflect-model";
// Issue #134. Comma-joined slugs, e.g. "reflect,digest" — deliberately not
// a JSON blob under one key: ADR 0008's stated reasoning for "no JSON blob"
// is that a shared shape means a corrupt or unparseable value for one
// setting can take out another on read, and a `String.split(",")` has
// nothing to parse that can throw the way `JSON.parse` can, so a hand-edited
// or truncated value degrades one slug at a time (`isHideableDestinationId`
// below) rather than losing the whole preference.
const HIDDEN_DESTINATIONS_KEY = "meologue.hidden-destinations";
const CAPABILITIES_KEY = "meologue.capabilities";

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

/**
 * How a checked checklist item's own text is drawn once it's ticked (issue
 * #163) — a Device-local display preference, exactly like `AccentId`/
 * `TextSizeId` above: it is a property of how this Device *paints* a task
 * item, not of the task item itself, so ADR 0008 puts it here rather than
 * touching an Entry's own stored text. Ticking a checkbox already flips one
 * character (`toggle-task.ts`'s `- [ ]` becomes `- [x]`, or the reverse);
 * this setting changes nothing about what gets written, Synced, or fed to
 * Digest — it only changes how an already-checked line is rendered once it
 * gets to screen, in both the Composer and History.
 *
 * Four values rather than two independent booleans ("gray" x "strike" as
 * separate switches): UpNote — which this app is explicitly matching here,
 * defaults included — offers exactly this set as one choice, not a pair of
 * toggles a reader would have to combine themselves to reach the same four
 * outcomes. UpNote's own companion setting, "move completed items to the
 * bottom," is deliberately not among them: that one reorders list items,
 * which is not display-only, and ADR 0043 gives the Composer alone the
 * right to normalize an Entry's body.
 */
export type CompletedStyleId = "grayAndStrike" | "gray" | "strike" | "none";

export const COMPLETED_STYLES: { id: CompletedStyleId; label: string }[] = [
  { id: "grayAndStrike", label: "Grayed out and strikethrough" },
  { id: "gray", label: "Grayed out" },
  { id: "strike", label: "Strikethrough" },
  { id: "none", label: "None" },
];

/**
 * Grayed out, with no strikethrough — UpNote's own default, verified in its
 * shipped bundle, not a guess at what "feels right" here. Matching it means
 * a reader who already knows UpNote sees the same shape a checked item
 * takes the first time they tick one, with no trip to Settings first.
 */
export const DEFAULT_COMPLETED_STYLE: CompletedStyleId = "gray";

/**
 * The Destinations a reader can hide from the root screen's list (issue
 * #134, extended to Todo by issue #168) — Composer, Reflect, Digest and
 * Todo, matching `chat-list.tsx`'s own `DESTINATIONS` slugs (each row's
 * `to` with the leading slash stripped). Settings is deliberately not one
 * of these ids and is never offered a control by `settings-page.tsx`: ADR
 * 0008/0009 make it the recovery route when the Entry store won't open or
 * the Server URL is wrong, so it must never be capable of disappearing
 * from the list that leads to it.
 */
export type HideableDestinationId = "composer" | "reflect" | "digest" | "todo";

export const HIDEABLE_DESTINATIONS: { id: HideableDestinationId; label: string }[] = [
  { id: "composer", label: "Composer" },
  { id: "reflect", label: "Reflect" },
  { id: "digest", label: "Digest" },
  { id: "todo", label: "Todo" },
];

/**
 * Nothing hidden — every Destination visible. This is also what a Device
 * that has never opened Settings and what a corrupt or unrecognised stored
 * value both degrade to (`readStoredHiddenDestinations` below), which is
 * what makes "absent means visible" true for a Destination this app adds
 * in some future version: it can never appear inside an *older* stored
 * value, so it is never in this set and is drawn exactly like every other
 * unhidden row.
 */
export const DEFAULT_HIDDEN_DESTINATIONS: ReadonlySet<HideableDestinationId> = new Set();

function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

function isTextSizeId(value: unknown): value is TextSizeId {
  return TEXT_SIZES.some((size) => size.id === value);
}

function isCompletedStyleId(value: unknown): value is CompletedStyleId {
  return COMPLETED_STYLES.some((style) => style.id === value);
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

function readStoredCompletedStyle(): CompletedStyleId {
  try {
    const stored = localStorage.getItem(COMPLETED_STYLE_KEY);
    return isCompletedStyleId(stored) ? stored : DEFAULT_COMPLETED_STYLE;
  } catch {
    return DEFAULT_COMPLETED_STYLE;
  }
}

function writeStoredCompletedStyle(style: CompletedStyleId): void {
  try {
    localStorage.setItem(COMPLETED_STYLE_KEY, style);
  } catch {
    // As above.
  }
}

/**
 * Whether the Composer's format toolbar (issue #164 — bold/italic/code, the
 * three list toggles, indent/outdent, Reference, undo/redo, in a row above
 * the input, shown only while the Composer has focus) is switched on at
 * all — a Device-local view preference, exactly like `AccentId`/
 * `TextSizeId`/`CompletedStyleId` above: it is a property of how this
 * Device draws the Composer's own chrome, never Synced, and never entering
 * the glossary for the same reason those three don't.
 *
 * Off by default. UpNote's own equivalent (`FORMAT_BAR_VISIBLE` in its
 * shipped bundle, verified the same way `DEFAULT_COMPLETED_STYLE` above
 * was) also defaults to `false` — a toolbar most Sends never touch should
 * not cost every reader a permanent row of vertical space in a footer that
 * already grows to eight lines and claims the bottom safe area
 * (composer.tsx's own layout comments). Reaching for it once, from the
 * toggle button beside Send, is what turns it on for good.
 *
 * Stored as the literal strings `"true"`/`"false"` rather than reusing the
 * `isXxxId`-against-a-list-of-known-values pattern every enum setting above
 * uses: a boolean has no finite id list to validate against, so
 * `readStoredFormatBarVisible` below treats anything other than the exact
 * string `"true"` — a missing key, a hand-edited value, a corrupt one, or a
 * stray `"1"` from some other convention — as `false`, which is also this
 * setting's own default. Corruption and "never touched this setting"
 * therefore degrade to the identical, safe answer, the same property
 * `isAccentId`/`isTextSizeId` give their own callers.
 */
export const DEFAULT_FORMAT_BAR_VISIBLE = false;

function readStoredFormatBarVisible(): boolean {
  try {
    return localStorage.getItem(FORMAT_BAR_VISIBLE_KEY) === "true";
  } catch {
    return DEFAULT_FORMAT_BAR_VISIBLE;
  }
}

function writeStoredFormatBarVisible(visible: boolean): void {
  try {
    localStorage.setItem(FORMAT_BAR_VISIBLE_KEY, visible ? "true" : "false");
  } catch {
    // Refused write — the in-memory value below still applies for this
    // session, same degradation every other setting here has.
  }
}

/**
 * Issue #170: whether Todo's add field runs the eager/natural-language
 * family of its quick-add parser at all — `QuickAddOptions.smartDates`
 * (packages/core/src/quick-add/types.ts), a caller-side switch rather
 * than something the parser itself is ever asked to guess at. Off turns
 * off `monday`, `5pm`, `monthly` and the rest of the family that infers
 * meaning from ordinary words with no marker the reader typed on purpose
 * — that type's own doc comment names this exactly as the family Todoist's
 * "Create **monthly** report" false positive belongs to. Sigil-marked
 * tokens (`#project`, `%label`, `p1`, `!reminder`, `{deadline}`,
 * `for 45min`, a leading `* `, `//`) are unaffected either way: a reader
 * who typed an explicit marker asked for that word to mean something, so
 * there is no false-positive risk this setting exists to let them turn
 * off.
 *
 * On by default — `QuickAddOptions.smartDates`'s own default, matched here
 * rather than diverging from it: the parser's own answer to "what happens
 * if a caller says nothing" and this setting's own default answer to the
 * identical question should be the same value, not two independent
 * decisions that happen to currently agree.
 *
 * Stored as the literal strings `"true"`/`"false"`, mirroring
 * `readStoredFormatBarVisible`'s own reasoning above: a boolean has no
 * finite id list `isCompletedStyleId`-style validation could check
 * against, so a missing key, a hand-edited value, or a stray `"1"` from
 * some other convention all read the same way — `true`, since that's also
 * this setting's own default, so corruption and "never touched this
 * setting" degrade to the identical, safe answer.
 */
export const DEFAULT_SMART_DATES_ENABLED = true;

function readStoredSmartDatesEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SMART_DATES_ENABLED_KEY);
    return stored === null ? DEFAULT_SMART_DATES_ENABLED : stored === "true";
  } catch {
    return DEFAULT_SMART_DATES_ENABLED;
  }
}

function writeStoredSmartDatesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SMART_DATES_ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    // Refused write — the in-memory value below still applies for this
    // session, same degradation every other setting here has.
  }
}

/**
 * Issue #202: which model a fresh `/reflect` Conversation starts on, before
 * the reader has touched `question-composer.tsx`'s own per-ask picker —
 * a Device-local default, exactly like `formatBarVisible`/
 * `smartDatesEnabled` above: it changes nothing about what the Server does
 * with a Question, only which option this Device's picker starts on.
 *
 * The empty string is the same "no override" value the picker's own local
 * state already uses for "Server default" (`question-composer.tsx`'s
 * `selectedModel`), so `defaultReflectModel` and a fresh ask's own
 * `selectedModel` share one meaning for "nothing chosen" rather than this
 * setting inventing a second sentinel (`null`, `"default"`) the picker
 * would have to translate. An opened Conversation that already has a Turn
 * of its own overrides this outright — `currentModel` wins over the
 * Device default the instant there is one, because the model a
 * Conversation is actually already on is a stronger fact than what a new
 * one would have started on.
 *
 * Not validated against a known model list on read, unlike `AccentId`/
 * `TextSizeId`/`CompletedStyleId` above: the Server's own model list is
 * fetched at runtime and can change between launches (`models-transport.ts`),
 * so there is no fixed set this module could check a stored value against
 * without a network call `readStoredDefaultReflectModel` — synchronous, at
 * module load, like every other read here — has no way to make. A stored
 * id the Server no longer offers behaves exactly like `currentModel` on an
 * older Session pointing at a retired model already does: the picker shows
 * whatever it shows for a value with no matching `<option>`, not a thrown
 * error.
 */
export const DEFAULT_REFLECT_MODEL = "";

function readStoredDefaultReflectModel(): string {
  try {
    return localStorage.getItem(DEFAULT_REFLECT_MODEL_KEY) ?? DEFAULT_REFLECT_MODEL;
  } catch {
    return DEFAULT_REFLECT_MODEL;
  }
}

function writeStoredDefaultReflectModel(model: string): void {
  try {
    if (model === "") {
      // No key at all rather than an empty string, mirroring
      // `writeStoredHiddenDestinations`'s own reasoning: a reader who picks
      // a default and then clears it back to "Server default" leaves no
      // trace in storage, indistinguishable from a Device that never
      // touched this setting.
      localStorage.removeItem(DEFAULT_REFLECT_MODEL_KEY);
    } else {
      localStorage.setItem(DEFAULT_REFLECT_MODEL_KEY, model);
    }
  } catch {
    // Refused write — the in-memory value below still applies for this
    // session, same degradation every other setting here has.
  }
}

function isHideableDestinationId(value: unknown): value is HideableDestinationId {
  return HIDEABLE_DESTINATIONS.some((destination) => destination.id === value);
}

/**
 * Issue #134. Splits the stored comma-joined string and keeps only the
 * slugs this build still recognises — silently, with no thrown error and
 * no visible warning, the same "ignore what you don't recognise" posture
 * `isAccentId`/`isTextSizeId` take on a single value, just applied per
 * element of a list instead of to one scalar. That's what makes a slug from
 * a future version of this app (forward compatibility) and a slug from a
 * hand-edited or truncated value (corruption) resolve the same way here:
 * both are simply absent from the returned set, and an absent Destination
 * is visible (`DEFAULT_HIDDEN_DESTINATIONS`'s own doc comment).
 */
function readStoredHiddenDestinations(): ReadonlySet<HideableDestinationId> {
  try {
    const stored = localStorage.getItem(HIDDEN_DESTINATIONS_KEY);
    if (stored === null || stored === "") {
      return DEFAULT_HIDDEN_DESTINATIONS;
    }
    return new Set(stored.split(",").filter(isHideableDestinationId));
  } catch {
    return DEFAULT_HIDDEN_DESTINATIONS;
  }
}

function writeStoredHiddenDestinations(hidden: ReadonlySet<HideableDestinationId>): void {
  try {
    if (hidden.size === 0) {
      // No key at all rather than an empty string, so a reader who once hid
      // every Destination and then unhid them all leaves no trace in
      // storage — indistinguishable from a Device that never touched this
      // setting, which is exactly what "nothing hidden" should be.
      localStorage.removeItem(HIDDEN_DESTINATIONS_KEY);
    } else {
      localStorage.setItem(HIDDEN_DESTINATIONS_KEY, Array.from(hidden).join(","));
    }
  } catch {
    // Refused write — the in-memory value below still applies for this
    // session, same degradation every other setting here has.
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

/**
 * Type-guards a parsed `localStorage` value before trusting it as
 * `ServerCapabilities` — the same defensiveness `isAccentId`/`isTextSizeId`
 * apply to a stored id, extended here to a whole shape rather than a single
 * string, since a hand-edited or previous-version value could be anything.
 */
function isServerCapabilities(value: unknown): value is ServerCapabilities {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ServerCapabilities).reflect === "boolean" &&
    typeof (value as ServerCapabilities).digest === "boolean" &&
    typeof (value as ServerCapabilities).embeddings === "boolean"
  );
}

/**
 * Issue #133: the last known answer to "which Server-backed Destinations
 * can this Server serve" — `null` for unknown, read synchronously at module
 * load exactly like `readStoredServerUrl` above, so `chat-list.tsx`'s
 * `useDestinations()` can decide whether a row locks with no network call
 * and no Entry-store read (ADR 0008/0009 — this pane has to keep rendering
 * beside `/settings` when the Entry store never opens at all).
 *
 * `null` here is a real, distinct state from "every capability is false":
 * it means this Device has never learned an answer (a fresh install, a
 * Server URL that was just changed, or a cache write that got refused),
 * and `chat-list.tsx` treats `null` as "unlocked" (optimistic-unknown) —
 * see `refreshCapabilities` below for the only thing that ever moves this
 * away from `null`.
 */
function readStoredCapabilities(): ServerCapabilities | null {
  try {
    const stored = localStorage.getItem(CAPABILITIES_KEY);
    if (stored === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(stored);
    return isServerCapabilities(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredCapabilities(capabilities: ServerCapabilities | null): void {
  try {
    if (capabilities === null) {
      localStorage.removeItem(CAPABILITIES_KEY);
    } else {
      localStorage.setItem(CAPABILITIES_KEY, JSON.stringify(capabilities));
    }
  } catch {
    // Refused write — the in-memory value below still applies for this
    // session, same degradation every other setting here has.
  }
}

interface SettingsState {
  theme: Theme;
  accent: AccentId;
  textSize: TextSizeId;
  completedStyle: CompletedStyleId;
  /** Issue #164: whether the Composer's format toolbar is switched on. See `DEFAULT_FORMAT_BAR_VISIBLE`'s own doc comment above. */
  formatBarVisible: boolean;
  /** Issue #170: whether Todo's add field runs its quick-add parser's eager/natural-language family. See `DEFAULT_SMART_DATES_ENABLED`'s own doc comment above. */
  smartDatesEnabled: boolean;
  /** Issue #202: which model a fresh Reflect Conversation starts on. See `DEFAULT_REFLECT_MODEL`'s own doc comment above. */
  defaultReflectModel: string;
  serverUrl: string;
  listWidth: number;
  capabilities: ServerCapabilities | null;
  /**
   * Whether the last request this Device actually sent to the Server got a
   * response, rather than failing at the network level (issue #133's
   * "Unreachable" state). Deliberately NOT persisted to `localStorage` the
   * way `capabilities` is: an outage is true only of this moment — "the
   * answer expires immediately" — so a stale `false` must never survive
   * into the next launch and report a Server that has been back up for
   * hours as still down. Defaults to `true` (optimistic, matching
   * `capabilities: null`'s own "unknown means unlocked" posture) and is
   * flipped by `server-request.ts`'s shared `serverRequest` helper, which
   * every transport (Reflect, Digest, Sessions, Models) already funnels
   * through — a real response of any status is reachability; only a thrown
   * `fetch` is not.
   */
  serverReachable: boolean;
  /**
   * Issue #134: which Destinations this reader has hidden from the root
   * screen's list — a Device-local view preference, exactly like `accent`
   * and `textSize` above, never Synced and never gating anything but the
   * row itself (`chat-list.tsx`'s `useDestinations()` is the only reader).
   */
  hiddenDestinations: ReadonlySet<HideableDestinationId>;
  setTheme: (theme: Theme) => void;
  setAccent: (accent: AccentId) => void;
  setTextSize: (size: TextSizeId) => void;
  setCompletedStyle: (style: CompletedStyleId) => void;
  setFormatBarVisible: (visible: boolean) => void;
  setSmartDatesEnabled: (enabled: boolean) => void;
  setDefaultReflectModel: (model: string) => void;
  setServerUrl: (url: string) => void;
  setListWidth: (width: number) => void;
  setCapabilities: (capabilities: ServerCapabilities | null) => void;
  setServerReachable: (reachable: boolean) => void;
  setHiddenDestinations: (hidden: ReadonlySet<HideableDestinationId>) => void;
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
  completedStyle: readStoredCompletedStyle(),
  formatBarVisible: readStoredFormatBarVisible(),
  smartDatesEnabled: readStoredSmartDatesEnabled(),
  defaultReflectModel: readStoredDefaultReflectModel(),
  serverUrl: readStoredServerUrl(),
  listWidth: readStoredListWidth(),
  capabilities: readStoredCapabilities(),
  serverReachable: true,
  hiddenDestinations: readStoredHiddenDestinations(),
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
  setCompletedStyle: (completedStyle) => {
    writeStoredCompletedStyle(completedStyle);
    set({ completedStyle });
  },
  setFormatBarVisible: (formatBarVisible) => {
    writeStoredFormatBarVisible(formatBarVisible);
    set({ formatBarVisible });
  },
  setSmartDatesEnabled: (smartDatesEnabled) => {
    writeStoredSmartDatesEnabled(smartDatesEnabled);
    set({ smartDatesEnabled });
  },
  setDefaultReflectModel: (defaultReflectModel) => {
    writeStoredDefaultReflectModel(defaultReflectModel);
    set({ defaultReflectModel });
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
  setCapabilities: (capabilities) => {
    writeStoredCapabilities(capabilities);
    set({ capabilities });
  },
  setServerReachable: (serverReachable) => {
    // In-memory only — see `SettingsState.serverReachable`'s own doc
    // comment on why this never touches `localStorage`.
    set({ serverReachable });
  },
  setHiddenDestinations: (hiddenDestinations) => {
    writeStoredHiddenDestinations(hiddenDestinations);
    set({ hiddenDestinations });
  },
}));

/** ADR 0011: an empty Server URL means Sync is off. Re-renders when the Server URL changes. */
export function useSyncEnabled(): boolean {
  return useSettingsStore((state) => state.serverUrl !== "");
}

/**
 * The last known capability report (issue #133), or `null` for unknown.
 * Read this, not `capabilities: null` directly, wherever a component needs
 * to react to a background refresh landing — `chat-list.tsx`'s
 * `useDestinations()` is the first caller.
 */
export function useCapabilities(): ServerCapabilities | null {
  return useSettingsStore((state) => state.capabilities);
}

/**
 * The last known reachability of the configured Server (issue #133) —
 * `true` until a request actually fails at the network level, never a
 * pre-emptive probe. See `SettingsState.serverReachable`'s own doc comment.
 */
export function useServerReachable(): boolean {
  return useSettingsStore((state) => state.serverReachable);
}

/**
 * Which Destinations this reader has hidden from the root screen's list
 * (issue #134). `chat-list.tsx`'s `useDestinations()` is the only caller
 * that needs this outside `settings-page.tsx`'s own controls — reading it
 * is what lets that list stay a pure derivation of the settings store, the
 * same posture `useSyncEnabled`/`useCapabilities` already have.
 */
export function useHiddenDestinations(): ReadonlySet<HideableDestinationId> {
  return useSettingsStore((state) => state.hiddenDestinations);
}

/**
 * Re-probes the configured Server's `/v1/health` in the background and
 * updates the capability cache and `serverReachable` with whatever it
 * learns — never awaited by anything that renders (issue #133). Called
 * once after this app's first paint (`main.tsx`) and again whenever a
 * Server URL is saved in Settings (`settings-page.tsx`'s `saveServerUrl`);
 * every reader above is a synchronous store read, and this is the only
 * thing that ever moves either value.
 *
 * An empty Server URL clears the cache outright rather than probing
 * anything — ADR 0011 already has an authoritative, free, offline answer
 * for that case (`useSyncEnabled`), and a stale capability report for a
 * Server this Device just disconnected from would be actively misleading.
 *
 * A network-level failure (`reason === "unreachable"`) marks
 * `serverReachable: false` and deliberately leaves `capabilities`
 * untouched: a Server that was reachable a moment ago and isn't right now
 * hasn't necessarily changed what it can serve, and overwriting a
 * known-good report with "unknown" here would undo the whole point of
 * caching it. Every other outcome — a real answer from the Server, even a
 * bad one (`http-error`, `protocol-mismatch`) or an unparseable URL — is
 * not a reachability failure, so it clears `capabilities` to unknown
 * (there is no capability report to trust) without touching
 * `serverReachable`.
 */
export async function refreshCapabilities(): Promise<void> {
  const store = useSettingsStore.getState();
  const url = store.serverUrl;

  if (url === "") {
    store.setCapabilities(null);
    store.setServerReachable(true);
    return;
  }

  const result = await checkServerUrl(url);
  if (result.ok) {
    store.setCapabilities(result.capabilities ?? null);
    store.setServerReachable(true);
  } else if (result.reason === "unreachable") {
    store.setServerReachable(false);
  } else {
    store.setCapabilities(null);
  }
}
