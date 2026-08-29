import { exportEntriesToZip, PROTOCOL_VERSION } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkServerUrl, type ServerCheckResult } from "@/lib/server-check";
import {
  ACCENTS,
  type AccentId,
  HIDEABLE_DESTINATIONS,
  type HideableDestinationId,
  normaliseServerUrl,
  refreshCapabilities,
  TEXT_SIZES,
  type TextSizeId,
  type Theme,
  useSettingsStore,
} from "@/lib/settings";
import { useSyncStatus } from "@/lib/sync-status";
import { applyAccent, applyTextSize, applyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";
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
  const storedServerUrl = useSettingsStore((state) => state.serverUrl);
  const hiddenDestinations = useSettingsStore((state) => state.hiddenDestinations);
  const setStoredTheme = useSettingsStore((state) => state.setTheme);
  const setStoredAccent = useSettingsStore((state) => state.setAccent);
  const setStoredTextSize = useSettingsStore((state) => state.setTextSize);
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

  // Always every Entry (store.list()), never the current search — a backup
  // that silently omits things is worse than none (ticket 46). No progress
  // UI: at personal-log scale this is fast enough that success/failure
  // toasts are the whole story.
  async function handleExport() {
    if (!opened) {
      return;
    }
    try {
      const entries = await opened.store.list();
      const { fileName, bytes } = exportEntriesToZip(entries, {
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
      const count = entries.length === 1 ? "1 Entry" : `${entries.length} Entries`;
      toast.success(`Exported ${count} to ${fileName}.`);
    } catch (error) {
      console.error("meologue: export failed", error);
      toast.error(error instanceof Error ? error.message : "Export failed.");
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
        Issue #134. Composer, Reflect and Digest only — Settings is never
        offered a control here, because ADR 0008/0009 make it the recovery
        route when the Entry store won't open or the Server URL is wrong,
        and a control that could hide the way out of every other problem
        this page fixes would defeat the point of it. `HIDEABLE_DESTINATIONS`
        (settings.ts) is the whole list this maps over, so there is no
        fourth row to accidentally add one to.

        This toggle reaches no Server and starts no request — it is a
        `localStorage` write, full stop. In particular it cannot stop a
        Digest being generated: the Digest worker runs on the Server's own
        schedule from Server configuration and takes no input from any
        Device (issue #134's own text). There is deliberately nothing here
        that calls the Server to try.
      */}
      <SettingsSection
        label="Chat list"
        hint="Hides the row only — the Destination itself keeps working. A hidden Composer, Reflect or Digest still opens at its own address, its Entries still appear in Reflection's Grounding, are still summarised into Digests, are still included in an Export, and still Sync to every other Device."
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
    </Shell>
  );
}
