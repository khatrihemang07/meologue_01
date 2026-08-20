import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { Nav } from "@/components/nav";
import { Shell } from "@/components/shell";
import { sessionsListTransport } from "@/lib/sessions-transport";
import { useSyncEnabled } from "@/lib/settings";

const SESSIONS_QUERY_KEY = ["sessions"] as const;

/**
 * A plain, local "last used" rendering ("just now", "12 minutes ago", "3
 * hours ago", "5 days ago"), falling back to a calendar date once the gap
 * is old enough that counting days stops being useful. Deliberately not
 * added to `lib/entry-time.ts`: that file's helpers are named and
 * documented around an Entry's own capture time, and a Session's
 * `updated_at` isn't one — CONTEXT.md's Session entry, not Entry. No repo
 * helper already does this (checked `lib/entry-day.ts` and
 * `packages/core/src/export/offset.ts`), and it doesn't earn a new
 * date-formatting dependency (ticket 33's constraint, unchanged), so it
 * stays here as the one place that needs it. `now` is a parameter rather
 * than a read of `Date.now()` inside the function, the same reason
 * `entry-day.ts`'s helpers take `offsetMinutes` explicitly — it's what
 * keeps this testable without mocking global time.
 */
export function formatLastUsed(iso: string, now: Date = new Date()): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const diffMs = now.getTime() - parsed;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  if (diffMs < minute) {
    return "Just now";
  }
  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (diffMs < day * 7) {
    const days = Math.floor(diffMs / day);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return new Date(parsed).toLocaleDateString(undefined, { dateStyle: "medium" });
}

// `/reflect/list` (ticket 62, ADR 0025): every Session the Server holds,
// newest first by when it was last used. Fetched fresh through TanStack
// Query on open (ADR 0013 — every read in this app goes through it) with
// no cache of its own beyond the query's default lifetime — ADR 0025 is
// explicit that the Device mirrors nothing, so a Session added or removed
// on another Device shows up simply by opening this screen again.
//
// Gated on Sync being on for the same reason Reflection itself is
// (reflection-page.tsx, ADR 0020): the Server holds every Session, so a
// Device with no Server URL has nowhere to ask. Three honest states beyond
// that gate — loading, empty, and unreachable — because ADR 0025 requires
// a Server outage to say so plainly rather than render as an empty list a
// reader could mistake for "no Sessions exist yet."
export function SessionsPage() {
  const syncEnabled = useSyncEnabled();

  const sessionsQuery = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: sessionsListTransport,
    enabled: syncEnabled,
  });

  const result = sessionsQuery.data;
  const loading = syncEnabled && sessionsQuery.isPending;
  const unreachable = result !== undefined && !result.ok;
  const sessions = result?.ok ? result.sessions : [];

  return (
    <Shell
      title="Sessions"
      back={
        <Link
          to="/reflect"
          aria-label="Back"
          // Matches SettingsLink's/settings-page.tsx's back control exactly
          // — same size-11 (44px) tap-target and hover treatment for the
          // same kind of app-bar icon control.
          className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Link>
      }
      nav={<Nav />}
    >
      {!syncEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to see your Sessions.
        </p>
      )}

      {syncEnabled && loading && (
        <p className="text-center text-sm text-muted-foreground">Loading Sessions…</p>
      )}

      {syncEnabled && unreachable && (
        // The Server holds every Session (ADR 0025) — an outage here
        // genuinely means the list cannot be shown, not that none exist.
        <p className="text-center text-sm text-muted-foreground">
          Couldn't load your Sessions. Check your Server and try again.
        </p>
      )}

      {syncEnabled && !loading && !unreachable && sessions.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">
          No Sessions yet — ask a Question in Reflect to start one.
        </p>
      )}

      {syncEnabled && !loading && !unreachable && sessions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link
                to={`/reflect/${session.id}`}
                className="flex flex-col gap-0.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted"
              >
                <span className="text-sm font-medium">{session.title}</span>
                <span className="text-xs text-muted-foreground">
                  {formatLastUsed(session.updated_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
