import { exportEntriesToZip, PROTOCOL_VERSION } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { ChoiceRow } from "@/components/settings/choice-row";
import { CompletedStyleRow } from "@/components/settings/completed-style-row";
import { DestinationVisibilityRow } from "@/components/settings/destination-visibility-row";
import { SettingsSection } from "@/components/settings/settings-section";
import { SmartDatesRow } from "@/components/settings/smart-dates-row";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkServerUrl, type ServerCheckResult } from "@/lib/server-check";
import {
  ACCENTS,
  type AccentId,
  COMPLETED_STYLES,
  type CompletedStyleId,
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
import { applyAccent, applyCompletedStyle, applyTextSize, applyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";
import { saveFile } from "@/platform/save-file";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

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
    </Shell>
  );
}
