import { exportEntriesToZip, PROTOCOL_VERSION } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Nav } from "@/components/nav";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkServerUrl, type ServerCheckResult } from "@/lib/server-check";
import { normaliseServerUrl, type Theme, useSettingsStore } from "@/lib/settings";
import { useSyncStatus } from "@/lib/sync-status";
import { applyTheme } from "@/lib/theme";
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
function describeServerCheck(result: ServerCheckResult): string {
  if (result.ok) {
    return "Reachable — this server is up and speaking the protocol this app expects.";
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
  const storedServerUrl = useSettingsStore((state) => state.serverUrl);
  const setStoredTheme = useSettingsStore((state) => state.setTheme);
  const setStoredServerUrl = useSettingsStore((state) => state.setServerUrl);
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

  function selectTheme(next: Theme) {
    applyTheme(next);
    setStoredTheme(next);
  }

  async function saveServerUrl() {
    setStoredServerUrl(serverUrl);
    // Show the normalised (trimmed, trailing-slash-stripped) value rather
    // than whatever the user typed. Computed, not read back from storage: a
    // refused write would make a read-back return the previous value and
    // blank the field the user just filled in.
    const normalised = normaliseServerUrl(serverUrl);
    setServerUrl(normalised);

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
    // Nav is a pair of bare route links, not a reader of the Entry store,
    // so it's just as live here as it is on Composer/History regardless of
    // whether the store ever opens.
    <Shell title="Settings" nav={<Nav />}>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Theme</span>
        <div className="inline-flex gap-1">
          {THEME_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={theme === option.value ? "default" : "outline"}
              aria-pressed={theme === option.value}
              onClick={() => selectTheme(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="server-url" className="text-sm font-medium">
          Server URL
        </label>
        <div className="flex gap-2">
          <Input
            id="server-url"
            type="text"
            placeholder="Leave empty to turn sync off"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
          <Button type="button" onClick={saveServerUrl}>
            Save
          </Button>
        </div>
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
          <p data-testid="sync-failure-reason" className="text-sm text-destructive">
            Sync is failing: {syncStatus.reason}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Export</span>
        <div>
          <Button type="button" onClick={handleExport} disabled={!opened}>
            Export as zip
          </Button>
        </div>
      </div>
    </Shell>
  );
}
