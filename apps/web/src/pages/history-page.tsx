import type { EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Composer } from "@/components/composer";
import { EntryList } from "@/components/entry-list";
import { Shell } from "@/components/shell";
import { useHistory } from "@/hooks/use-history";
import { SecondTabError, StorageUnavailableError } from "@/lib/entry-store-errors";
import { createDriver } from "@/platform/sqlite-driver";

type EntryStoreState =
  | { status: "loading" }
  | { status: "ready"; store: EntryStore; deviceId: string }
  | { status: "error"; message: string };

// This is the composition root for the sqlite-driver seam (ticket 24): each
// platform file supplies only a driver, and the store is opened here, once,
// rather than duplicated per platform.
async function openEntryStore() {
  const driver = await createDriver();
  return open(driver);
}

// A Device has exactly one store for the life of a page load, so this is
// memoized at module scope rather than per-mount: React 19's StrictMode
// mounts, cleans up, and remounts effects once in development, and without
// this a second openEntryStore() call would spin up a second Worker
// competing with the first for the same OPFS pool lock, producing a
// self-inflicted SecondTabError before a real second tab ever opens one.
// Module scope also survives routing away to Settings and back (ticket 25):
// the effect below re-runs on remount, but it reuses this same promise
// rather than reopening the store.
let entryStorePromise: ReturnType<typeof openEntryStore> | null = null;

function describeOpenError(error: unknown): string {
  if (error instanceof SecondTabError) {
    return "meologue is already open in another tab. Close it there, or continue in this one.";
  }
  if (error instanceof StorageUnavailableError) {
    return "meologue can't store Entries here — try a non-private window over HTTPS or localhost.";
  }
  console.error("meologue: failed to open the entry store", error);
  return "meologue couldn't open its storage. Reloading may help.";
}

function noop() {}

// Present regardless of store status (loading, ready, or error) — Settings
// is reachable even while the store is still opening or failed to.
function SettingsLink() {
  return (
    <Link
      to="/settings"
      aria-label="Settings"
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      <Settings aria-hidden="true" className="size-4" />
    </Link>
  );
}

export function HistoryPage() {
  const [state, setState] = useState<EntryStoreState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    entryStorePromise ??= openEntryStore();
    entryStorePromise.then(
      (opened) => {
        if (!cancelled) {
          setState({ status: "ready", ...opened });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: describeOpenError(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "ready") {
    return <Ready store={state.store} deviceId={state.deviceId} />;
  }

  return (
    <Shell
      title="Meologue"
      action={<SettingsLink />}
      message={state.status === "error" ? state.message : undefined}
      footer={<EntryList entries={[]} />}
    >
      <Composer onSend={noop} disabled />
    </Shell>
  );
}

// Composition root for ADR 0001: the store comes from HistoryPage's async
// startup, not this component, so a component that always calls useHistory
// only mounts once the store actually exists — useHistory can't be called
// conditionally from within HistoryPage itself.
function Ready({ store, deviceId }: { store: EntryStore; deviceId: string }) {
  const { entries, sendEntry } = useHistory(store, deviceId);
  return (
    <Shell title="Meologue" action={<SettingsLink />} footer={<EntryList entries={entries} />}>
      <Composer onSend={sendEntry} />
    </Shell>
  );
}
