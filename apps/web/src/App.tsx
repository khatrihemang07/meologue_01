import type { EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Composer } from "@/components/composer";
import { EntryList } from "@/components/entry-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function App() {
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
      message={state.status === "error" ? state.message : undefined}
      composer={<Composer onSend={noop} disabled />}
      entries={<EntryList entries={[]} />}
    />
  );
}

// Composition root for ADR 0001: the store comes from App's async startup,
// not this component, so a component that always calls useHistory only
// mounts once the store actually exists — useHistory can't be called
// conditionally from within App itself.
function Ready({ store, deviceId }: { store: EntryStore; deviceId: string }) {
  const { entries, sendEntry } = useHistory(store, deviceId);
  return (
    <Shell composer={<Composer onSend={sendEntry} />} entries={<EntryList entries={entries} />} />
  );
}

function Shell({
  message,
  composer,
  entries,
}: {
  message?: string;
  composer: ReactNode;
  entries: ReactNode;
}) {
  return (
    <div className="flex min-h-svh justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Meologue</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {message && <p className="text-sm text-destructive">{message}</p>}
            {composer}
          </CardContent>
        </Card>

        {entries}
      </div>
    </div>
  );
}

export default App;
