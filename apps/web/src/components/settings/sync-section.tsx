import { PROTOCOL_VERSION } from "@meologue/core";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DeviceGroup } from "@/components/settings/device-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkServerUrl, type ServerCheckResult } from "@/lib/server-check";
import { normaliseServerUrl, refreshCapabilities, useSettingsStore } from "@/lib/settings";
import { useSyncStatus } from "@/lib/sync-status";
import { cn } from "@/lib/utils";

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

/**
 * How this Device reaches the Server it Syncs through — the Server URL
 * itself and its own reachability — the fourth of five topic sections
 * `settings-page.tsx` composes (issue #202).
 *
 * The Server URL is, today, the only setting in this section, and it's a
 * Device setting (ADR 0008): the address one Device points at is a fact
 * about that Device's own configuration, not something the Server holds on
 * every Device's behalf. It stays under "On this device" for exactly that
 * reason. A Server setting proper — configuration the Server holds for
 * itself, reachable from any Device (CONTEXT.md's own new **Server
 * setting** entry) — is what the "On the server" sub-group this ticket
 * leaves unused is waiting for; the ticket that adds one is blocked on this
 * one landing first.
 */
export function SyncSection() {
  const storedServerUrl = useSettingsStore((state) => state.serverUrl);
  const setStoredServerUrl = useSettingsStore((state) => state.setServerUrl);
  const syncStatus = useSyncStatus();

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

  const status = check?.url === serverUrl ? check.result : null;

  return (
    <section aria-labelledby="sync-heading" className="flex flex-col gap-4">
      <h2 id="sync-heading" className="font-semibold text-sm">
        Sync
      </h2>
      <DeviceGroup heading="On this device">
        <SettingsSection label="Server URL">
          {/*
            Issue #76: a real <form>, submitted on plain Enter — not the
            Composer's chord (submit-chord.ts). That chord exists to keep
            Enter free for a newline inside a multi-line textarea; a
            single-line input has no newline to protect, so there's nothing
            for a modifier to guard here, and requiring one would just be an
            extra keystroke standing between the user and Save for no
            benefit. The button becomes type="submit" so it triggers the
            same form submission Enter does, rather than the two paths
            calling saveServerUrl independently and drifting apart later.

            The visible label is `SettingsSection`'s own, and the <label
            for> below it is `sr-only` rather than deleted: an <input>
            needs a real label, and two visible ones saying "Server URL"
            would say it twice.
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
                // Not-configured is a valid, deliberate state (ADR 0011) —
                // the user turned sync off, not a failure — so it reads
                // the same muted tone as "ok", not the red "something's
                // wrong" tone every other failure reason gets.
                status.ok || (!status.ok && status.reason === "not-configured")
                  ? "text-muted-foreground"
                  : "text-destructive",
              )}
            >
              {describeServerCheck(status)}
            </p>
          )}
          {syncStatus.state === "failing" && serverUrl === storedServerUrl && (
            // The reason Sync itself is actually failing (ticket 40) —
            // distinct from `status` above, which is a one-off
            // reachability probe. This reflects real, ongoing sync
            // attempts, and clears on its own the next time one succeeds,
            // no reload needed. Only shown once the field matches what's
            // saved, same reasoning as `status`: mid-edit, the reason on
            // screen would be about an address the user is in the middle
            // of replacing.
            <p data-testid="sync-failure-reason" className="text-destructive text-sm">
              Sync is failing: {syncStatus.reason}
            </p>
          )}
        </SettingsSection>
      </DeviceGroup>
    </section>
  );
}
