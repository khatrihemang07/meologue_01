import { Button } from "@/components/ui/button";

/**
 * The persistent notice a Reflection or Digest screen shows once the
 * Server has stopped answering — issue #133's "Unreachable" state,
 * "known only from a request that failed, and the answer expires
 * immediately" (the ticket's own words for `settings.ts`'s
 * `serverReachable`, which every caller here reads to decide whether to
 * render this at all).
 *
 * Replaces what used to be a one-shot error toast on the request that
 * discovered the outage: a toast is gone the moment it fades, and every
 * fresh render of the same broken state used to need one of its own. This
 * stays on screen for as long as the Server does not answer, and it is
 * where "read yes, write no" actually shows up — Reflection drops its
 * Question input while this renders (`reflection-page.tsx`), and Digest was
 * already read-only, so this is the whole of its own degradation.
 *
 * Deliberately muted, never `text-destructive` — CONTEXT.md's Sync status
 * entry is explicit that an outage "reads as a neutral state, not an
 * error," the same posture `chat-list.tsx`'s locked rows take for the same
 * reason: a Server being unreachable right now says nothing about whether
 * this Device's own setup is wrong.
 *
 * `onRetry` is the caller's own re-probe, not a call this component makes
 * itself — `refreshCapabilities()` (`settings.ts`) is what every caller
 * uses to learn whether the Server has come back, but each of the two
 * pages that render this also has its own cached read to nudge once that
 * happens (Reflection's Session, Digest's cards), so the composition lives
 * with them rather than being guessed at here.
 */
export function ServerUnreachableBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="server-unreachable-banner"
      className="flex flex-col items-center gap-2 rounded-lg border border-[var(--separator)] bg-muted/40 px-4 py-3 text-center"
    >
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
