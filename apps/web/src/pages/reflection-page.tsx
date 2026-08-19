import { Link } from "react-router";
import { Nav, SettingsLink } from "@/components/nav";
import { Shell } from "@/components/shell";
import { useSyncEnabled } from "@/lib/settings";

// `/reflect` — the third peer view of History, alongside `/` and
// `/history` (ADR 0020). Ticket 2 only makes Reflection a *place*: no
// Question can be asked yet (that's a later ticket), so both states below
// are read-only hints. Reflection needs a Server (CONTEXT.md: "Reflection"
// reads History, and Grounding always comes from the user's own History),
// so it gates on the same useSyncEnabled() check composer-page.tsx already
// uses for its own Sync-off hint, and matches that hint's tone and
// structure rather than inventing a new one.
export function ReflectionPage() {
  const syncEnabled = useSyncEnabled();

  return (
    <Shell title="Reflect" action={<SettingsLink />} nav={<Nav />}>
      {syncEnabled ? (
        // No Conversation has started yet — nothing to render but an
        // invitation. No text input here: that's a later ticket's job.
        <p className="text-center text-sm text-muted-foreground">
          Ask a Question about your History to start a Conversation.
        </p>
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to use Reflection.
        </p>
      )}
    </Shell>
  );
}
