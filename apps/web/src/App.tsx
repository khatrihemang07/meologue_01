import { useMemo } from "react";
import { Composer } from "@/components/composer";
import { EntryList } from "@/components/entry-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHistory } from "@/hooks/use-history";
import { getDeviceId } from "@/lib/device-id";
import { LocalEntryStore } from "@/lib/local-entry-store";

function App() {
  // Composition root for ADR 0001: the concrete store is wired here, not
  // inside useHistory, so swapping in the real embedded store later means
  // changing this one line, not the hook.
  const store = useMemo(() => new LocalEntryStore(), []);
  const deviceId = useMemo(() => getDeviceId(), []);
  const { entries, sendEntry } = useHistory(store, deviceId);

  return (
    <div className="flex min-h-svh justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Meologue</CardTitle>
          </CardHeader>
          <CardContent>
            <Composer onSend={sendEntry} />
          </CardContent>
        </Card>

        <EntryList entries={entries} />
      </div>
    </div>
  );
}

export default App;
