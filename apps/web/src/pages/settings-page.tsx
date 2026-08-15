import { PROTOCOL_VERSION } from "@meologue/core";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BackLink } from "@/components/nav-links";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkServerUrl, type ServerCheckResult } from "@/lib/server-check";
import {
  normaliseServerUrl,
  readServerUrl,
  readTheme,
  type Theme,
  writeServerUrl,
  writeTheme,
} from "@/lib/settings";
import { applyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

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
  // Initialised from storage, not a fixed default, so the control shows
  // what's actually in effect (main.tsx already applied it before this
  // page ever rendered).
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [serverUrl, setServerUrl] = useState(() => readServerUrl());

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
    const stored = readServerUrl();
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
    setTheme(next);
    applyTheme(next);
    writeTheme(next);
  }

  async function saveServerUrl() {
    writeServerUrl(serverUrl);
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
    } else {
      toast.error(message);
    }
  }

  const status = check?.url === serverUrl ? check.result : null;

  return (
    <Shell title="Settings">
      <BackLink />

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
            placeholder="Leave empty to use this app's default"
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
            className={cn("text-sm", status.ok ? "text-muted-foreground" : "text-destructive")}
          >
            {describeServerCheck(status)}
          </p>
        )}
      </div>
    </Shell>
  );
}
