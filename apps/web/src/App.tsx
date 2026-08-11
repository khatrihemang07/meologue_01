import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

function App() {
  return (
    <div className="flex min-h-svh justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Meologue</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea placeholder="What's on your mind?" disabled />
            <Button disabled className="self-end">
              Send
            </Button>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">History will appear here.</p>
      </div>
    </div>
  );
}

export default App;
