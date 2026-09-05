import {
  createBackup,
  exportEntriesToZip,
  PROTOCOL_VERSION,
  restoreFromBackup,
  unzipBackup,
} from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkServerUrl, type ServerCheckResult } from "@/lib/server-check";
import {
  ACCENTS,
  type AccentId,
  applyDeviceSettings,
  COMPLETED_STYLES,
  type CompletedStyleId,
  HIDEABLE_DESTINATIONS,
  type HideableDestinationId,
  normaliseServerUrl,
  readAllDeviceSettings,
  refreshCapabilities,
  TEXT_SIZES,
  type TextSizeId,
  type Theme,
  useSettingsStore,
} from "@/lib/settings";
import { useSyncStatus } from "@/lib/sync-status";
import { applyAccent, applyCompletedStyle, applyTextSize, applyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";
import { loadFile } from "@/platform/load-file";
import { saveFile } from "@/platform/save-file";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * One section's shape, so every section on this page has the same one
 * (#128). The label, the optional line explaining what the control does,
 * and the control itself sit at fixed gaps here rather than being written
 * out five times — which is how a page ends up pairing its tightest gap
 * with its heaviest control and nobody notices.
 *
 * A `<fieldset>` with a real `<legend>`, so the visible label IS the group's
 * accessible name. Three of these five sections are genuinely groups of
 * mutually exclusive choices; naming them with a `<span>` and then adding
 * `role="group"` plus an `aria-label` elsewhere would say the same word
 * twice, once to a reader's eyes and once to their screen reader.
 *
 * `mb-2` on the legend rather than a gap: a `<legend>` is laid out specially
 * by the UA and is not a flex item of its own fieldset, so a `gap` on the
 * fieldset would silently not apply to the one place this page most needs it
 * to. The margin and the inner `gap-2` are deliberately the same number.
 */
function SettingsSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // `min-w-0` fights the UA's own `min-inline-size: min-content` on a
    // fieldset, which would otherwise let a long status line push this
    // section wider than the column it sits in.
    <fieldset className="min-w-0">
      <legend className="mb-2 font-medium text-sm">{label}</legend>
      {hint && <p className="mb-2 text-muted-foreground text-xs">{hint}</p>}
      <div className="flex flex-col gap-2">{children}</div>
    </fieldset>
  );
}

/**
 * A row of mutually exclusive choices, laid out as an even grid rather than
 * a wrapping flex row.
 *
 * The grid is what stops the fifth Accent swatch from orphaning onto a row
 * of its own: a `flex-wrap` row breaks wherever it runs out of width, which
 * on a phone is after four. `grid-cols-5` is five even columns at every
 * width the app supports — 5 x 44px plus four 8px gaps is 252px, inside the
 * content width of the narrowest Device this runs on.
 *
 * `aria-pressed` toggles rather than real radios, matching what the Theme
 * control on this page already did before there were three of these: one
 * pattern for all three groups is worth more here than the marginally
 * better semantics of a radio group in one of them and not the others. The
 * group's own name comes from `SettingsSection`'s `<legend>`, not from here.
 */
function ChoiceRow({ columns, children }: { columns: 3 | 5; children: React.ReactNode }) {
  return (
    <div className={cn("grid gap-2", columns === 3 ? "grid-cols-3" : "grid-cols-5")}>
      {children}
    </div>
  );
}

/**
 * One Destination's own on/off row in the "Chat list" section (issue #134).
 *
 * Not a `ChoiceRow` (above): that control is a fixed-width group of
 * mutually exclusive options — exactly one Theme, one Text size — and its
 * own doc comment is explicit that `aria-pressed` toggles are standing in
 * for a radio group. A visibility switch is a different shape entirely:
 * three *independent* on/off facts, not one choice among several, so this
 * is a real `role="switch"` with `aria-checked` rather than a fourth
 * `aria-pressed` button pretending to be part of a choice it isn't.
 *
 * `size="touch"` on the switch itself, not just the row it sits in — ADR
 * 0036's 44px minimum is a property of the interactive element a thumb has
 * to land on, and this button already carries the `Button` component's
 * `touch` size for exactly that reason (button.tsx's own comment on why
 * Settings controls default away from the pointer-sized `h-8`).
 */
function DestinationVisibilityRow({
  label,
  hidden,
  onToggle,
}: {
  label: string;
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">{label}</span>
      <Button
        type="button"
        size="touch"
        variant={hidden ? "outline" : "default"}
        role="switch"
        aria-checked={!hidden}
        aria-label={`${label} in the chat list`}
        onClick={onToggle}
      >
        {hidden ? "Hidden" : "Visible"}
      </Button>
    </div>
  );
}

/**
 * The "Smart date recognition" row (issue #170) — a single independent
 * on/off fact, the same shape `DestinationVisibilityRow` above is, so it
 * reuses that control's exact `role="switch"`/`aria-checked` pattern
 * rather than `ChoiceRow`'s mutually-exclusive-options one. Not built on
 * `DestinationVisibilityRow` itself: that component's own copy
 * ("Hidden"/"Visible", "`${label}` in the chat list") is specific to
 * hiding a Destination's row, and bending it to a second, unrelated
 * on/off setting via extra props would cost more legibility than the few
 * duplicated lines below save.
 */
function SmartDatesRow({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">Smart date recognition</span>
      <Button
        type="button"
        size="touch"
        variant={enabled ? "default" : "outline"}
        role="switch"
        aria-checked={enabled}
        aria-label="Smart date recognition"
        onClick={onToggle}
      >
        {enabled ? "On" : "Off"}
      </Button>
    </div>
  );
}

/**
 * One row of the "Completed checklist item" section (issue #163) — a full
 * width `aria-pressed` toggle, not a `ChoiceRow`: that control's own doc
 * comment fixes its grid at three or five even columns, sized for a short
 * word or a swatch, and "Grayed out and strikethrough" truncates badly at
 * either width on a phone. A stacked row can be as wide as the whole
 * section instead.
 *
 * The point of this control is "choose by looking," not "choose by
 * reading" — so each row renders a real sample checklist item in its own
 * style below the label, rather than describing the style in more words.
 * That sample wears the exact markup shape a real checked task item has in
 * both render paths (a `<li class="... list-none ...">` holding a checked
 * `<input type="checkbox">` beside a sibling `<div>` — see
 * `entry-prose.tsx`'s `renderListItem` and `composer-editor.ts`'s
 * `listItemNodeView`), which is what lets `index.css`'s one shared rule
 * (`li.list-none input[type="checkbox"]:checked ~ div`) style this sample
 * too, with no second, hand-written mapping of style id to colour and
 * decoration living here. `data-completed-style={option.id}` on the small
 * wrapper around the sample is what feeds that rule THIS row's own option
 * rather than whichever one is actually selected right now — the two
 * custom properties the rule reads resolve from the nearest ancestor
 * carrying the attribute, and this wrapper sits closer to the sample than
 * `<html>` does.
 *
 * The sample is `aria-hidden` and its checkbox `disabled`: it exists to be
 * looked at, not tabbed to or announced twice on top of the row's own
 * label, which is already this `Button`'s full accessible name.
 */
function CompletedStyleRow({
  option,
  selected,
  onSelect,
}: {
  option: { id: CompletedStyleId; label: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      size="touch"
      variant={selected ? "default" : "outline"}
      aria-pressed={selected}
      onClick={onSelect}
      className="h-auto w-full flex-col items-start gap-1.5 px-4 py-3 text-left"
    >
      <span className="text-sm">{option.label}</span>
      <div data-completed-style={option.id} aria-hidden="true" className="pointer-events-none">
        <ul className="m-0 list-none p-0">
          <li className="flex list-none items-baseline gap-1.5">
            {/*
             * A drawn box, deliberately NOT an `<input type="checkbox">`.
             * This preview is decorative — it illustrates what a finished
             * item looks like; there is nothing here to tick. A real form
             * control was a genuine defect, and `settings.spec.ts` caught
             * it: that suite's touch-target sweep finds controls with the
             * CSS selector `fieldset input`, which `aria-hidden` does not
             * exclude, and reported a 13px-tall, unnamed, focusable,
             * tabbable checkbox in each of these four rows. Four extra tab
             * stops that announce nothing, inside a button that is itself
             * the control. A `<span>` cannot be focused, cannot be tabbed
             * to, and cannot be mistaken for something to click.
             *
             * `border-current` rather than a fixed colour: these rows
             * render on both the `default` and `outline` Button variants,
             * whose foregrounds differ, and the box has to stay visible on
             * each. The sample TEXT beside it deliberately does not inherit
             * that — it wears `.completed-sample`, which reads the same two
             * custom properties the real render paths read, so the preview
             * is showing the actual styling rather than an imitation of it.
             */}
            <span className="mt-[0.2em] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-current text-[0.6rem] leading-none">
              ✓
            </span>
            <div className="completed-sample min-w-0 flex-1 text-sm">Buy milk</div>
          </li>
        </ul>
      </div>
    </Button>
  );
}

// Distinct, actionable copy per outcome (ticket 30). A failed `fetch` in a
// browser is opaque — DNS failure, connection refused, TLS failure, CORS
// rejection and OS cleartext blocking are all indistinguishable from
// JavaScript — so "unreachable" is deliberately the one honest catch-all
// rather than several confident guesses.
//
// Issue #133: a bare "Reachable" was true and useless on a Server that
// answers its health check but can serve neither Destination — this names
// the specific gap instead, straight off the same `capabilities` object
// `useDestinations()` (`chat-list.tsx`) locks rows against, so Settings and
// the chat list can never disagree about what a Server can do. `undefined`
// (an older Server, or one this check hasn't learned the answer from yet)
// still reads as a plain "Reachable" — Settings has no missing-model gap to
// name when it doesn't know one exists, the same "unknown means unlocked"
// posture the chat list takes.
function describeServerCheck(result: ServerCheckResult): string {
  if (result.ok) {
    const capabilities = result.capabilities;
    if (capabilities === undefined) {
      return "Reachable — this server is up and speaking the protocol this app expects.";
    }
    const missing: string[] = [];
    if (!capabilities.reflect) missing.push("Reflect");
    if (!capabilities.digest) missing.push("Digest");
    if (missing.length === 0) {
      return "Reachable — this server is up and speaking the protocol this app expects.";
    }
    // "no Digest model configured" for one gap; "no Reflect or Digest model
    // configured" for both — `capabilities.embeddings` never gates a
    // Destination row on its own (see `useDestinations()`), so it's left
    // out of this sentence even though the Server reports it.
    const gap = missing.map((name) => `${name} model`).join(" or ");
    return `Reachable — but this server has no ${gap} configured.`;
  }
  switch (result.reason) {
    case "not-configured":
      return "No server configured — sync is off. Enter an address to turn it on.";
    case "invalid-url":
      return "That's not a valid URL. Enter a full address, like https://example.com.";
    case "unreachable":
      return "Couldn't reach this address. Check that the server is running and the address is correct.";
    case "http-error":
      return `Server responded with an error (HTTP ${result.status}). Check the server's logs.`;
    case "protocol-mismatch":
      return `Server speaks protocol v${result.serverVersion}; this app expects v${PROTOCOL_VERSION}. Update the app or the server so they match.`;
  }
}

export function SettingsPage() {
  // From the store, not local state — main.tsx already applied this theme
  // before this page ever rendered, and reading it through the store rather
  // than copying it into local state means this control can never drift
  // from what's actually in effect.
  const theme = useSettingsStore((state) => state.theme);
  const accent = useSettingsStore((state) => state.accent);
  const textSize = useSettingsStore((state) => state.textSize);
  const completedStyle = useSettingsStore((state) => state.completedStyle);
  const smartDatesEnabled = useSettingsStore((state) => state.smartDatesEnabled);
  const storedServerUrl = useSettingsStore((state) => state.serverUrl);
  const hiddenDestinations = useSettingsStore((state) => state.hiddenDestinations);
  const setStoredTheme = useSettingsStore((state) => state.setTheme);
  const setStoredAccent = useSettingsStore((state) => state.setAccent);
  const setStoredTextSize = useSettingsStore((state) => state.setTextSize);
  const setStoredCompletedStyle = useSettingsStore((state) => state.setCompletedStyle);
  const setStoredSmartDatesEnabled = useSettingsStore((state) => state.setSmartDatesEnabled);
  const setStoredServerUrl = useSettingsStore((state) => state.setServerUrl);
  const setStoredHiddenDestinations = useSettingsStore((state) => state.setHiddenDestinations);
  const syncStatus = useSyncStatus();

  // Settings is a sibling route outside EntryStoreLayout (ADR 0008/0009), so
  // it has no store handle of its own — subscribing to the same
  // entryStoreQueryOptions SyncLoop uses (use-sync-loop.ts) is how it learns
  // whether the store is open, without duplicating how it's opened.
  const storeQuery = useQuery(entryStoreQueryOptions);
  const opened = storeQuery.data;

  // A local draft, seeded from the store's current value: the field must
  // keep showing exactly what the user is typing, uncommitted, until Save —
  // reading straight from the store here would overwrite that with the
  // last-saved value on every store update.
  const [serverUrl, setServerUrl] = useState(() => useSettingsStore.getState().serverUrl);

  // The most recent check's result, keyed to the exact URL string it was
  // measured against. The status below is only ever shown while `serverUrl`
  // still equals `check.url` — there's no separate dirty flag to fall out of
  // step with an edit, and editing the field away and back to the same text
  // brings the status back on its own, with no re-check.
  const [check, setCheck] = useState<{ url: string; result: ServerCheckResult } | null>(null);

  // Issue #197: the Backup a user just picked, parsed enough to drive the
  // confirmation dialog below — non-null is what makes that dialog open.
  // `databaseSql` is carried through untouched (restoreFromBackup does its
  // own, stricter parse against the live schema); `settings` and
  // `incomingServerUrl` are read here only far enough to show the user what
  // they're about to get, never applied before they confirm.
  const [restorePreview, setRestorePreview] = useState<{
    databaseSql: string;
    settings: Record<string, string>;
    incomingServerUrl: string;
    takenAt: string | null;
  } | null>(null);
  // A typed confirmation, not a toast (issue #197's own explicit
  // requirement) — Restore is the one operation that destroys History on
  // purpose, so the destructive button below stays disabled until this
  // matches RESTORE_CONFIRM_WORD exactly.
  const [restoreConfirmText, setRestoreConfirmText] = useState("");
  // Defaults to keeping this Device's current Server URL, never the
  // incoming one — ADR 0011 makes an unreachable Server URL mean "Sync is
  // off" *silently*, so the safer default is the one that can't turn Sync
  // off without the user noticing.
  const [useIncomingServerUrl, setUseIncomingServerUrl] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState("");

  // Runs once, silently, against whatever is already saved — arriving at
  // the page tells the user where things stand without them pressing
  // anything. No toast here: only the Save action below gets one. Guarded
  // like EntryStoreLayout's own async effect (entry-store-layout.tsx):
  // navigating away from Settings before the health check's timeout
  // resolves must not set state on an unmounted component.
  useEffect(() => {
    let cancelled = false;
    const stored = useSettingsStore.getState().serverUrl;
    checkServerUrl(stored).then((result) => {
      if (!cancelled) {
        setCheck({ url: stored, result });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply first, then persist — the same order `selectTheme` has always
  // used. The visible effect is a custom property or a class on <html>, and
  // a storage write that throws (private browsing) must not be what stands
  // between the reader and the change they just asked for.
  function selectTheme(next: Theme) {
    applyTheme(next);
    setStoredTheme(next);
  }

  function selectAccent(next: AccentId) {
    applyAccent(next);
    setStoredAccent(next);
  }

  // No `apply*` step to run first, unlike theme/accent/text size — hiding a
  // Destination has nothing to paint immediately on *this* screen; the only
  // visible effect is the next time `chat-list.tsx` renders, which happens
  // wherever this reader navigates to next.
  function toggleDestinationHidden(id: HideableDestinationId) {
    const next = new Set(hiddenDestinations);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setStoredHiddenDestinations(next);
  }

  function selectTextSize(next: TextSizeId) {
    applyTextSize(next);
    setStoredTextSize(next);
  }

  // Apply first, then persist — same order as every other visible choice on
  // this page. "Apply" here is one attribute write (`applyCompletedStyle`);
  // it rewrites no Entry, starts no Sync, and marks no Digest stale, per
  // ADR 0008 and this setting's own doc comment in settings.ts.
  function selectCompletedStyle(next: CompletedStyleId) {
    applyCompletedStyle(next);
    setStoredCompletedStyle(next);
  }

  // No `applyX` step, unlike selectCompletedStyle/selectTextSize above:
  // there is no on-screen paint for a `localStorage` write to drive
  // immediately (add-task-form.tsx reads this setting itself, the next
  // time it renders), the same reasoning toggleDestinationHidden's own
  // comment gives for its identical one-line body.
  function toggleSmartDatesEnabled() {
    setStoredSmartDatesEnabled(!smartDatesEnabled);
  }

  async function saveServerUrl() {
    setStoredServerUrl(serverUrl);
    // Show the normalised (trimmed, trailing-slash-stripped) value rather
    // than whatever the user typed. Computed, not read back from storage: a
    // refused write would make a read-back return the previous value and
    // blank the field the user just filled in.
    const normalised = normaliseServerUrl(serverUrl);
    setServerUrl(normalised);

    // Issue #133: refreshes the capability cache `chat-list.tsx` reads —
    // fire-and-forget, exactly like the boot-time call in `main.tsx`. This
    // page's own `status`/`describeServerCheck` line below is a separate,
    // synchronous-feeling one-off probe against the same URL, awaited for
    // its own testid-bearing message; that await is unrelated to this call,
    // which nothing here renders against.
    refreshCapabilities();

    const result = await checkServerUrl(normalised);
    setCheck({ url: normalised, result });
    const message = describeServerCheck(result);
    if (result.ok) {
      toast.success(message);
    } else if (result.reason === "not-configured") {
      // Not an error — the user just turned sync off, which is a valid
      // outcome of Save, not a failure of it (ADR 0011).
      toast(message);
    } else {
      toast.error(message);
    }
  }

  // Always every Entry (store.list()), every Task (taskStore.list() +
  // listCompleted()) and every Project (projectStore.listProjects()),
  // never the current search — a backup that silently omits things is
  // worse than none (ticket 46, extended to Tasks by issue #175: ADR 0016
  // was written about Entries when Entries were the only thing there was
  // to omit). No progress UI: at personal-log scale this is fast enough
  // that success/failure toasts are the whole story.
  async function handleExport() {
    if (!opened) {
      return;
    }
    try {
      const [entries, activeTasks, completedTasks, projects] = await Promise.all([
        opened.store.list(),
        opened.taskStore.list(),
        opened.taskStore.listCompleted(),
        opened.projectStore.listProjects(),
      ]);
      // Both active and completed — see tasks-file.ts's own doc comment
      // for why a backup includes what's done, not just what's open.
      const tasks = [...activeTasks, ...completedTasks];
      const { fileName, bytes } = exportEntriesToZip(entries, tasks, projects, {
        deviceId: opened.deviceId,
        now: new Date(),
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      });
      const outcome = await saveFile(fileName, bytes);
      if (outcome === "cancelled") {
        // The user backed out of the save panel / share sheet — nothing was
        // written anywhere. Export is a backup, and a false "Exported"
        // toast here would tell the user they have a copy of their History
        // they don't; cancelling is the user changing their mind, and it
        // needs no acknowledgement, success or error (ticket 47's defect
        // fix — see save-file.web.ts's SaveFileOutcome doc comment and
        // docs/adr/0016).
        return;
      }
      const entryLabel = entries.length === 1 ? "1 Entry" : `${entries.length} Entries`;
      const taskLabel = tasks.length === 1 ? "1 Task" : `${tasks.length} Tasks`;
      toast.success(`Exported ${entryLabel} and ${taskLabel} to ${fileName}.`);
    } catch (error) {
      console.error("meologue: export failed", error);
      toast.error(error instanceof Error ? error.message : "Export failed.");
    }
  }

  // A Backup (issue #195, CONTEXT.md's Backup entry) is a second, separate
  // artifact from Export just above — a lossless SQL dump of this Device's
  // whole database plus its settings, answering "is my data safe" rather
  // than Export's "can I read this." `opened.driver` is the raw
  // `SqliteDriver` `entry-store-layout.tsx`'s `open()` already constructed
  // (../../../packages/core/src/sqlite/open.ts's own `OpenedSqliteStore.
  // driver` doc comment) — `createBackup` reads `sqlite_master` directly,
  // below every store's own abstraction, so it needs that driver itself,
  // not a store built on top of it. `readAllDeviceSettings()` (settings.ts)
  // is the one place `packages/core` gets `localStorage`'s contents from:
  // that package has no `localStorage` of its own to read (ADR 0008), so
  // Settings collects the `meologue.*` keys and hands them over the same
  // way it hands over `deviceId` below. No progress UI, same reasoning as
  // handleExport just above: at personal-log scale a Backup is fast enough
  // that a toast is the whole story.
  async function handleBackup() {
    if (!opened) {
      return;
    }
    try {
      const { fileName, bytes } = await createBackup(opened.driver, readAllDeviceSettings(), {
        deviceId: opened.deviceId,
        now: new Date(),
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      });
      const outcome = await saveFile(fileName, bytes);
      if (outcome === "cancelled") {
        // The user backed out of the save panel / share sheet — nothing was
        // written anywhere. Same defect fix Export's own handleExport
        // already applies (its own comment above, ticket 47, docs/adr/0016):
        // a false "Backed up" toast here would claim a copy of this
        // Device's whole database exists when it doesn't.
        return;
      }
      toast.success(`Backed up this Device to ${fileName}.`);
    } catch (error) {
      console.error("meologue: backup failed", error);
      toast.error(error instanceof Error ? error.message : "Backup failed.");
    }
  }

  // The word a reader must type verbatim before the destructive Restore
  // button in the confirmation dialog below is enabled — issue #197's own
  // "a typed confirmation, not a toast" requirement for the one operation
  // that destroys History on purpose.
  const RESTORE_CONFIRM_WORD = "RESTORE";

  // Opens the confirmation dialog rather than restoring immediately —
  // picking and unzipping the file is not itself destructive, so it needs
  // no confirmation of its own; only handleConfirmRestore below writes
  // anything. `unzipBackup`/JSON.parse failures here are reported and stop
  // before the dialog ever opens, so a reader is never asked to confirm
  // restoring a file this build can't even read the wrapper of.
  async function handlePickRestoreFile() {
    if (!opened) {
      return;
    }
    const picked = await loadFile();
    if (picked.outcome === "cancelled") {
      // The user backed out of the file picker — nothing to report, the
      // same silent-on-cancel posture handleExport/handleBackup already
      // take for their own save-side pickers (ticket 47, docs/adr/0016).
      return;
    }
    const unzipped = unzipBackup(picked.bytes);
    if (!unzipped.ok) {
      toast.error(unzipped.reason);
      return;
    }

    // settings.json and meta.json are read only far enough to populate the
    // confirmation dialog (the incoming Server URL, and when the Backup was
    // taken) — parsed defensively, not validated against a schema: a
    // Backup's own database.sql is the thing restoreFromBackup actually
    // applies and structurally checks; these two files are shown, not
    // written, until the user confirms.
    let settings: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(unzipped.backup.settingsJson);
      if (typeof parsed === "object" && parsed !== null) {
        settings = parsed as Record<string, string>;
      }
    } catch {
      // An unreadable settings.json still lets the data itself restore —
      // the confirmation dialog just shows no incoming Server URL and
      // applies no settings, rather than refusing the whole Restore over a
      // file that fails to parse for a concern this page treats as
      // secondary to the data.
    }
    let takenAt: string | null = null;
    try {
      const meta: unknown = JSON.parse(unzipped.backup.metaJson);
      const takenAtValue =
        typeof meta === "object" && meta !== null
          ? (meta as Record<string, unknown>).taken_at
          : undefined;
      takenAt = typeof takenAtValue === "string" ? takenAtValue : null;
    } catch {
      takenAt = null;
    }

    setRestorePreview({
      databaseSql: unzipped.backup.databaseSql,
      settings,
      incomingServerUrl:
        typeof settings["meologue.server-url"] === "string" ? settings["meologue.server-url"] : "",
      takenAt,
    });
    setRestoreConfirmText("");
    setUseIncomingServerUrl(false);
  }

  // The confirmation dialog's own destructive action — everything this
  // ticket's brief calls for happens here, in order: replace the database
  // (restoreFromBackup, which does its own BEGIN/COMMIT/ROLLBACK and FTS5
  // rebuild), then apply the Backup's settings silently (applyDeviceSettings
  // — this overturns ADR 0008, see the ADR that supersedes it), then apply
  // the incoming Server URL only if the reader explicitly chose to
  // (useIncomingServerUrl; ADR 0011's "an unreachable Server URL means Sync
  // is off, silently" is exactly why this is never applied by default).
  //
  // Reloads the page on success, after a moment for the success toast to be
  // read: Restore replaces the database and settings out from under every
  // already-rendered part of this app (React Query's cached reads, the
  // Zustand settings store's own state, the Nav's lock checks) — a full
  // reload is the same honest "start over from what's actually on disk now"
  // reset app-error-boundary.tsx's own Reload button already uses for a
  // comparable "too much has changed to patch in place" situation.
  async function handleConfirmRestore() {
    if (!opened || restorePreview === null) {
      return;
    }
    setRestoring(true);
    setRestoreProgress("Starting…");
    try {
      const outcome = await restoreFromBackup(
        opened.driver,
        restorePreview.databaseSql,
        (message) => setRestoreProgress(message),
      );
      if (!outcome.ok) {
        toast.error(outcome.reason);
        return;
      }

      applyDeviceSettings(restorePreview.settings);
      if (useIncomingServerUrl) {
        useSettingsStore.getState().setServerUrl(restorePreview.incomingServerUrl);
      }

      const { inserted, updated, unchanged, skippedTables, skippedColumns } = outcome.result;
      const skippedCount = skippedTables.length + skippedColumns.length;
      toast.success(
        `Restored: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged.${
          skippedCount > 0
            ? ` ${skippedCount} field(s) from a different build's Backup were skipped.`
            : ""
        }`,
      );
      setRestorePreview(null);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      console.error("meologue: restore failed", error);
      toast.error(error instanceof Error ? error.message : "Restore failed.");
    } finally {
      setRestoring(false);
    }
  }

  const status = check?.url === serverUrl ? check.result : null;

  return (
    // Settings gets the same persistent Nav as every other page (ticket 54
    // — "every page becomes reachable directly"), even though Settings
    // itself is a sibling route outside EntryStoreLayout (ADR 0008/0009):
    // Nav is four bare route links, not a reader of the Entry store, so
    // it's just as live here as it is on Composer/Reflect/Digest regardless
    // of whether the store ever opens.
    //
    // No `back` slot any more (issue #75, superseding ADR 0019's "Back
    // returns to Settings" — that decision existed only because Settings
    // used to be reachable but not a destination in its own right, so
    // "where the user was" was the only useful thing Settings could say
    // about leaving. Settings is now itself one of the four Nav
    // destinations (nav.tsx's DESTINATIONS), same as Composer/Reflect/
    // Digest, none of which get a Back either — ADR 0018's original
    // argument for that ("with the destination always reachable, a back
    // affordance only described where the user had been, not where they
    // could go") applies to Settings now for the same reason it always
    // applied to the other three.
    <Shell title="Settings" back={<BackToChats />}>
      <SettingsSection label="Theme">
        <ChoiceRow columns={3}>
          {THEME_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="touch"
              variant={theme === option.value ? "default" : "outline"}
              aria-pressed={theme === option.value}
              onClick={() => selectTheme(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </ChoiceRow>
      </SettingsSection>

      <SettingsSection label="Accent" hint="Recolours your own Entries, right away.">
        <ChoiceRow columns={5}>
          {ACCENTS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-label={option.label}
              aria-pressed={accent === option.id}
              onClick={() => selectAccent(option.id)}
              className={cn(
                "flex h-11 flex-col items-center justify-center gap-1 rounded-lg border transition-colors",
                accent === option.id
                  ? "border-foreground bg-muted"
                  : "border-transparent hover:bg-muted",
              )}
            >
              {/*
                The colour comes from `index.css`'s own per-Accent variable
                rather than an inline hex, so a swatch can never show one
                colour while the thread paints another.
              */}
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full"
                style={{ backgroundColor: `var(--accent-${option.id})` }}
              />
              <span className="w-full truncate px-0.5 text-center text-[10px] text-muted-foreground">
                {option.label}
              </span>
            </button>
          ))}
        </ChoiceRow>
      </SettingsSection>

      <SettingsSection
        label="Text size"
        hint="Changes the words you wrote. The time, the sync tick and the day label stay the same size."
      >
        <ChoiceRow columns={3}>
          {TEXT_SIZES.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="touch"
              variant={textSize === option.id ? "default" : "outline"}
              aria-pressed={textSize === option.id}
              onClick={() => selectTextSize(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </ChoiceRow>
      </SettingsSection>

      {/*
        Issue #163. Display only, exactly like Accent and Text size above:
        the four stacked rows below change how a checked item is PAINTED in
        both the Composer and History, and nothing about what's stored,
        Synced, or fed to a Digest. UpNote's companion "move completed
        items to the bottom" is deliberately not offered here — see
        `CompletedStyleId`'s own doc comment (settings.ts) for why that one
        doesn't belong beside a display-only choice.
      */}
      <SettingsSection
        label="Completed checklist item"
        hint="Changes how a ticked checkbox's own words look. Nothing about what you wrote, Synced, or already summarised into a Digest changes."
      >
        {COMPLETED_STYLES.map((option) => (
          <CompletedStyleRow
            key={option.id}
            option={option}
            selected={completedStyle === option.id}
            onSelect={() => selectCompletedStyle(option.id)}
          />
        ))}
      </SettingsSection>

      {/*
        Issue #134, extended to Todo by issue #168. Settings is never
        offered a control here, because ADR 0008/0009 make it the recovery
        route when the Entry store won't open or the Server URL is wrong,
        and a control that could hide the way out of every other problem
        this page fixes would defeat the point of it. `HIDEABLE_DESTINATIONS`
        (settings.ts) is the whole list this maps over, so a fifth row added
        there in some future version shows up here with no further change.

        This toggle reaches no Server and starts no request — it is a
        `localStorage` write, full stop. In particular it cannot stop a
        Digest being generated: the Digest worker runs on the Server's own
        schedule from Server configuration and takes no input from any
        Device (issue #134's own text). There is deliberately nothing here
        that calls the Server to try.
      */}
      <SettingsSection
        label="Chat list"
        hint="Hides the row only — the Destination itself keeps working. A hidden Composer, Reflect, Digest or Todo still opens at its own address; a hidden Entry-backed row still appears in Reflection's Grounding, is still summarised into Digests, is still included in an Export, and still Syncs to every other Device — Todo has no Server-side counterpart to any of that, but hiding its row is exactly as reversible."
      >
        {HIDEABLE_DESTINATIONS.map((destination) => (
          <DestinationVisibilityRow
            key={destination.id}
            label={destination.label}
            hidden={hiddenDestinations.has(destination.id)}
            onToggle={() => toggleDestinationHidden(destination.id)}
          />
        ))}
      </SettingsSection>

      {/*
        Issue #170. Off stops only the eager/natural-language family the
        add field's quick-add parser runs on ordinary words with no marker
        typed on purpose — `monday`, `5pm`, `monthly`, Todoist's own
        documented "Create **monthly** report" false positive
        (packages/core/src/quick-add/types.ts's own QuickAddTokenKind doc
        comment names the family exactly). `#project`, `%label`, `p1`,
        `!reminder`, `{deadline}`, `for 45min` and the rest of the
        sigil-marked family keep working regardless: a reader who typed an
        explicit marker asked for that word to mean something, so there is
        no false-positive risk this setting exists to let them turn off.
      */}
      <SettingsSection
        label="Todo"
        hint="Off still recognises #project, %label, p1-p4, !reminder, {deadline} and for 45min in the add field — only words like monday, 5pm or monthly stop being read as dates."
      >
        <SmartDatesRow enabled={smartDatesEnabled} onToggle={toggleSmartDatesEnabled} />
      </SettingsSection>

      <SettingsSection label="Server URL">
        {/*
          Issue #76: a real <form>, submitted on plain Enter — not the
          Composer's chord (submit-chord.ts). That chord exists to keep
          Enter free for a newline inside a multi-line textarea; a
          single-line input has no newline to protect, so there's nothing
          for a modifier to guard here, and requiring one would just be an
          extra keystroke standing between the user and Save for no
          benefit. The button becomes type="submit" so it triggers the same
          form submission Enter does, rather than the two paths calling
          saveServerUrl independently and drifting apart later.

          The visible label is `SettingsSection`'s own, and the <label for>
          below it is `sr-only` rather than deleted: an <input> needs a real
          label, and two visible ones saying "Server URL" would say it twice.
        */}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveServerUrl();
          }}
        >
          <label htmlFor="server-url" className="sr-only">
            Server URL
          </label>
          <Input
            id="server-url"
            type="text"
            placeholder="Leave empty to turn sync off"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            className="h-11"
          />
          <Button type="submit" size="touch">
            Save
          </Button>
        </form>
        {status && (
          <p
            data-testid="server-status"
            className={cn(
              "text-sm",
              // Not-configured is a valid, deliberate state (ADR 0011) — the
              // user turned sync off, not a failure — so it reads the same
              // muted tone as "ok", not the red "something's wrong" tone
              // every other failure reason gets.
              status.ok || (!status.ok && status.reason === "not-configured")
                ? "text-muted-foreground"
                : "text-destructive",
            )}
          >
            {describeServerCheck(status)}
          </p>
        )}
        {syncStatus.state === "failing" && serverUrl === storedServerUrl && (
          // The reason Sync itself is actually failing (ticket 40) — distinct
          // from `status` above, which is a one-off reachability probe. This
          // reflects real, ongoing sync attempts, and clears on its own the
          // next time one succeeds, no reload needed. Only shown once the
          // field matches what's saved, same reasoning as `status`: mid-edit,
          // the reason on screen would be about an address the user is in the
          // middle of replacing.
          <p data-testid="sync-failure-reason" className="text-destructive text-sm">
            Sync is failing: {syncStatus.reason}
          </p>
        )}
      </SettingsSection>

      <SettingsSection label="Export">
        <div>
          <Button type="button" size="touch" onClick={handleExport} disabled={!opened}>
            Export as zip
          </Button>
        </div>
      </SettingsSection>

      {/*
        Issue #195. Sits beside Export, not inside it — a Backup and an
        Export are two different artifacts (CONTEXT.md's Backup entry): an
        Export is a readable zip of day files an Export's own hint text
        above doesn't need repeating here, and a Backup is a lossless SQL
        dump of this Device's whole database, settings included, meant to
        be restored rather than read.
      */}
      <SettingsSection
        label="Backup"
        hint="A lossless copy of everything on this Device — every Entry, Task, Project, Section, Label, Filter, Comment and Event, tombstones included, plus your settings. Meant to be restored, not read — see Export above for a plain-text copy you can open directly."
      >
        <div>
          <Button type="button" size="touch" onClick={handleBackup} disabled={!opened}>
            Back up this Device
          </Button>
        </div>
      </SettingsSection>

      {/*
        Issue #197. Restore is the honest, destructive counterpart to
        Backup just above: "this Device becomes the Backup" rather than
        "gains a copy of it." Deliberately its own section, not folded into
        Backup's: the two do opposite things to the same artifact, and a
        reader scanning this page should never mistake one button for the
        other.
      */}
      <SettingsSection
        label="Restore"
        hint="Replaces everything on this Device with a Backup's contents. This is the one action on this page that destroys History on purpose — you'll be asked to confirm before anything is written."
      >
        <div>
          <Button
            type="button"
            size="touch"
            variant="destructive"
            onClick={handlePickRestoreFile}
            disabled={!opened || restoring}
          >
            Restore from a Backup…
          </Button>
        </div>
      </SettingsSection>

      <RestoreConfirmDialog
        open={restorePreview !== null}
        onOpenChange={(nextOpen) => {
          // Ignore a dismiss attempt (Escape, outside click) while the
          // write is actually in flight — closing the dialog mid-Restore
          // would hide the one place its progress is shown, not stop the
          // Restore itself, which is already running against the driver.
          if (!nextOpen && restoring) {
            return;
          }
          if (!nextOpen) {
            setRestorePreview(null);
          }
        }}
        takenAt={restorePreview?.takenAt ?? null}
        currentServerUrl={storedServerUrl}
        incomingServerUrl={restorePreview?.incomingServerUrl ?? ""}
        useIncomingServerUrl={useIncomingServerUrl}
        onUseIncomingServerUrlChange={setUseIncomingServerUrl}
        confirmText={restoreConfirmText}
        onConfirmTextChange={setRestoreConfirmText}
        confirmWord={RESTORE_CONFIRM_WORD}
        restoring={restoring}
        progress={restoreProgress}
        onConfirm={handleConfirmRestore}
      />
    </Shell>
  );
}

/**
 * "Type <word> to confirm" — the one form of confirmation this page's own
 * Restore button asks for (issue #197's own explicit requirement: "a typed
 * confirmation, not a toast"). Deliberately case-sensitive, exact-match
 * comparison in the caller (settings-page.tsx's `RESTORE_CONFIRM_WORD`
 * check) rather than a case-insensitive one: a reader who types "restore"
 * without looking closely at the required word hasn't actually read it,
 * which is the entire point of asking for it typed rather than clicked.
 */
function formatTakenAt(takenAt: string | null): string {
  if (takenAt === null) {
    return "an unknown time";
  }
  const parsed = Date.parse(takenAt);
  if (Number.isNaN(parsed)) {
    return takenAt;
  }
  return new Date(parsed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Restore's own confirmation dialog (issue #197) — not `ConfirmDialog`
 * (components/ui/alert-dialog.tsx): that component's three-string-plus-
 * callback shape fits a plain "are you sure" (Entry delete, Session
 * delete), but this dialog needs three things neither of those did — the
 * Backup's own `taken_at` shown for context, an accept-or-keep choice over
 * the incoming Server URL (ADR 0011), and a typed word gating the
 * destructive button rather than a click alone. Built directly on the same
 * Radix `Dialog` primitive `alert-dialog.tsx` itself is built on, with the
 * identical `role="alertdialog"` reasoning that file's own header comment
 * gives (Escape and an outside click both still dismiss it, matching this
 * app's own resolution of that point against Radix's more restrictive
 * `AlertDialog` primitive) — except the confirm button here is a plain
 * `onClick`, not a `Dialog.Close`: this dialog stays open, showing
 * `progress`, for the whole time `restoring` is true, rather than closing
 * the instant the button is pressed the way `ConfirmDialog`'s always does.
 */
function RestoreConfirmDialog({
  open,
  onOpenChange,
  takenAt,
  currentServerUrl,
  incomingServerUrl,
  useIncomingServerUrl,
  onUseIncomingServerUrlChange,
  confirmText,
  onConfirmTextChange,
  confirmWord,
  restoring,
  progress,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  takenAt: string | null;
  currentServerUrl: string;
  incomingServerUrl: string;
  useIncomingServerUrl: boolean;
  onUseIncomingServerUrlChange: (value: boolean) => void;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  confirmWord: string;
  restoring: boolean;
  progress: string;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const canConfirm = confirmText === confirmWord && !restoring;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          role="alertdialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus({ preventScroll: true });
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title className="text-sm font-medium text-foreground">
            Restore this Device from a Backup?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1.5 text-sm text-muted-foreground">
            Taken {formatTakenAt(takenAt)}. Every Entry, Task, Project, Section, Label, Filter,
            Comment and Event on this Device is replaced with what's in the Backup. Anything created
            here since then that hasn't Synced yet will be lost.
          </DialogPrimitive.Description>

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-sm">
              Server URL:{" "}
              {useIncomingServerUrl ? incomingServerUrl || "(none)" : currentServerUrl || "(none)"}
            </span>
            <Button
              type="button"
              size="sm"
              variant={useIncomingServerUrl ? "default" : "outline"}
              role="switch"
              aria-checked={useIncomingServerUrl}
              aria-label="Use the Backup's Server URL"
              disabled={restoring}
              onClick={() => onUseIncomingServerUrlChange(!useIncomingServerUrl)}
            >
              {useIncomingServerUrl ? "Use Backup's" : "Keep current"}
            </Button>
          </div>
          <p className="mt-1 text-muted-foreground text-xs">
            The Backup's own Server URL is {incomingServerUrl || "(none)"} — shown, never applied
            without a choice (ADR 0011: an unreachable Server URL turns Sync off silently).
          </p>

          <label className="mt-3 block text-sm" htmlFor="restore-confirm-word">
            Type {confirmWord} to confirm
          </label>
          <Input
            id="restore-confirm-word"
            value={confirmText}
            onChange={(event) => onConfirmTextChange(event.target.value)}
            disabled={restoring}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />

          {restoring && (
            <p aria-live="polite" className="mt-3 text-muted-foreground text-sm">
              {progress}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button
                ref={cancelRef}
                type="button"
                variant="outline"
                size="sm"
                disabled={restoring}
              >
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              Restore
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
