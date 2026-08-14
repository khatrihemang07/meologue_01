import type { Entry, EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import { useEffect, useState } from "react";
import { Outlet, useOutletContext } from "react-router";
import { ensureContinuousSync, useHistory } from "@/hooks/use-history";
import { SecondTabError, StorageUnavailableError } from "@/lib/entry-store-errors";
import { createDriver } from "@/platform/sqlite-driver";

type EntryStoreState =
  | { status: "loading" }
  | { status: "ready"; store: EntryStore; deviceId: string }
  | { status: "error"; message: string };

export interface EntryStoreOutletContext {
  entries: Entry[];
  sendEntry: (raw: string) => void;
  disabled: boolean;
  message?: string;
}

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

/**
 * The composition root for ADR 0001 and ADR 0009: opens the Entry store and
 * runs `useHistory` exactly once, above the routes that read from it — `/`
 * and `/history` (ticket 27), which both render whatever this layout puts
 * on the outlet context rather than each owning their own store and sync
 * loop. Settings is a sibling route outside this layout, not a child of it
 * (ADR 0008): it must stay usable even when the store below never reaches
 * "ready", and the only way to guarantee that structurally is to keep it
 * off this component's subtree entirely.
 */
export function EntryStoreLayout() {
  const [state, setState] = useState<EntryStoreState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    entryStorePromise ??= openEntryStore();
    entryStorePromise.then(
      (opened) => {
        // Unconditional — not guarded by `cancelled`. A user who navigates
        // to Settings before the store finishes opening unmounts this
        // layout (and with it, the `Ready` component below that would
        // otherwise start sync via useHistory) before this ever settles.
        // Sync still has to start once the store exists, regardless of
        // which page is on screen when it does (ADR 0009).
        ensureContinuousSync(opened.store, opened.deviceId);
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
    <Outlet
      context={
        {
          entries: [],
          sendEntry: noop,
          disabled: true,
          message: state.status === "error" ? state.message : undefined,
        } satisfies EntryStoreOutletContext
      }
    />
  );
}

function Ready({ store, deviceId }: { store: EntryStore; deviceId: string }) {
  const { entries, sendEntry } = useHistory(store, deviceId);
  return (
    <Outlet context={{ entries, sendEntry, disabled: false } satisfies EntryStoreOutletContext} />
  );
}

/** Read by `/` and `/history` — anything rendered outside EntryStoreLayout's Outlet must not call this. */
export function useEntryStore(): EntryStoreOutletContext {
  return useOutletContext<EntryStoreOutletContext>();
}
