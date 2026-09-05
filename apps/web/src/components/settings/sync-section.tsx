import type { WireConfigPatch, WireConfigResponse } from "@meologue/core";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DeviceGroup } from "@/components/settings/device-group";
import {
  describeConfigFailure,
  ServerGroup,
  ServerSaveButton,
  type ServerSaveStatus,
  ServerSaveStatusLine,
  ServerTextField,
} from "@/components/settings/server-config-form";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConfigResult } from "@/lib/config-transport";
import { describeServerCheck } from "@/lib/describe-server-check";
import { checkServerUrl, type ServerCheckResult } from "@/lib/server-check";
import { normaliseServerUrl, refreshCapabilities, useSettingsStore } from "@/lib/settings";
import { useSyncStatus } from "@/lib/sync-status";
import { useServerConfig } from "@/lib/use-server-config";
import { cn } from "@/lib/utils";

/**
 * How this Device reaches the Server it Syncs through — the Server URL
 * itself and its own reachability — the fourth of five topic sections
 * `settings-page.tsx` composes (issue #202) — plus, since issue #203, the
 * one Server setting that belongs here rather than in AI: the timezone
 * Digest buckets by.
 *
 * The Server URL itself stays a Device setting (ADR 0008): the address one
 * Device points at is a fact about that Device's own configuration, not
 * something the Server holds on every Device's behalf. The timezone is the
 * opposite — a fact about the one Server process every Device Syncs
 * through, which is exactly what CONTEXT.md's **Server setting** entry and
 * ADR 0060 give a place to live. It rides under this section rather than
 * AI because it's Digest's own axis, not a chat/embed one, and Digest has
 * no topic section of its own on this page.
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

  // Issue #203: shared with `ServerGroup` below and with nothing else on
  // this page — see `ai-section.tsx`'s own identical `configState` comment
  // for why this is created once here rather than inside the field
  // component that actually renders the timezone row.
  const configState = useServerConfig();

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

      <ServerGroup heading="On the server" query={configState.query}>
        {(config) => <ServerSyncFields config={config} save={configState.save} />}
      </ServerGroup>
    </section>
  );
}

/**
 * The Sync section's one server row: the timezone Digest buckets by.
 *
 * `original`/`draft`/dirty-tracking mirrors `ai-section.tsx`'s own
 * `ServerAiFields` exactly, at one field's scale instead of ten — see that
 * component's doc comment for the reasoning behind re-seeding from `config`
 * rather than from a ref, and for why only a genuinely edited field ever
 * reaches the `PATCH` body at all.
 *
 * The restart notice here is unconditional on any successful write that
 * actually touched `tz`, unlike `ai-section.tsx`'s three feature toggles:
 * ADR 0060 is explicit that a stored timezone value only takes effect the
 * next time `main.rs` runs `settings::resolve` at boot — there is no
 * `FeatureConfig`-style `configured`/`boot_active` pair for `tz` to read
 * this off of the way there is for Reflect/Digest/Embeddings, because
 * nothing about the timezone gates route registration in the first place.
 * So this reads it off the mutation's own outcome instead: "did the write
 * that just landed include a changed tz," which is a fact about the write
 * this Device just made, not a guess about the Server's internals.
 */
function ServerSyncFields({
  config,
  save,
}: {
  config: WireConfigResponse;
  save: (patch: WireConfigPatch) => Promise<ConfigResult>;
}) {
  const original = config.tz.value ?? "";
  const [draft, setDraft] = useState(original);
  const [status, setStatus] = useState<ServerSaveStatus>({ state: "idle" });
  const [justChangedTz, setJustChangedTz] = useState(false);

  useEffect(() => {
    setDraft(config.tz.value ?? "");
  }, [config]);

  const locked = config.locked;
  const dirty = draft !== original;

  async function handleSave() {
    setStatus({ state: "saving" });
    const result = await save({ tz: draft });
    if (result.ok) {
      setStatus({ state: "saved" });
      setJustChangedTz(true);
    } else {
      setStatus({ state: "failed", message: describeConfigFailure(result) });
    }
  }

  return (
    <>
      <SettingsSection
        label="Timezone"
        hint="The zone Digest buckets day/week/month by, e.g. America/New_York. Clear it to fall back to the environment."
      >
        <ServerTextField
          id="server-timezone"
          label="Timezone"
          field={config.tz}
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setStatus({ state: "idle" });
            setJustChangedTz(false);
          }}
          locked={locked}
        />
      </SettingsSection>
      <div className="flex items-center gap-3">
        <ServerSaveButton onClick={handleSave} disabled={locked || !dirty} label="Save timezone" />
        <ServerSaveStatusLine status={status} />
      </div>
      {justChangedTz && (
        <p data-testid="sync-restart-required" className="text-muted-foreground text-xs">
          Restart the server for the new timezone to take effect.
        </p>
      )}
    </>
  );
}
