import { Composer } from "@/components/composer";
import { EntryList } from "@/components/entry-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHistory } from "@/hooks/use-history";

function App() {
  const { entries, sendEntry } = useHistory();

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
