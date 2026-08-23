import type { WireSessionSummary } from "@meologue/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Nav, NewSessionLink } from "@/components/nav";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { clearLastSessionId, readLastSessionId } from "@/lib/last-session";
import { sessionsDeleteTransport, sessionsListTransport } from "@/lib/sessions-transport";
import { useSyncEnabled } from "@/lib/settings";

const SESSIONS_QUERY_KEY = ["sessions"] as const;

/**
 * Issue #64's Search debounce, in milliseconds. Unlike `use-entry-search.ts`
 * (local, in-process search — cheap enough to run on every keystroke), this
 * page's search is a round trip to the Server (`GET /v1/sessions?q=`), so an
 * un-debounced query would fire one request per keystroke. Kept small
 * (rather than the 300-500ms a typical "search-as-you-type" box might use)
 * because a Session list is usually short and this Server call is already
 * cheap — plain `ILIKE`, no embedding — so there's little to gain from a
 * longer wait, only a less responsive field.
 */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * Issue #64: debounces `query` by `SEARCH_DEBOUNCE_MS`, so `sessionsQuery`
 * below only re-fetches once the reader pauses rather than on every
 * keystroke. Kept local to this page rather than promoted to a shared hook
 * — `use-history-search.ts` exists because History/Composer's search state
 * (URL param, sessionStorage backup) is shared between two pages; Sessions
 * has neither of those and only one page, so there is nothing yet to share.
 */
function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);

  return debounced;
}

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

/**
 * One row of the Sessions list, plus its own delete affordance — deleting
 * is the first thing this app can remove at all (Entries are immutable and
 * un-deletable by design), so it deliberately does not read like an
 * ordinary list row's hover state the way an Entry in History does.
 *
 * The confirm step is a plain in-row two-step (issue #63's own suggestion,
 * followed rather than reaching for a new dialog library the rest of the
 * codebase has none of): tapping the trash icon replaces the row's link
 * with a warning and a `destructive`-variant Button — the one place in this
 * app that variant is used — rather than firing the delete on the first
 * tap. The warning names both things ADR 0025/0003 make true of a Session
 * and nothing else in this app: the deletion is permanent, and it takes
 * effect on every Device, not just this one.
 */
function SessionRow({
  session,
  confirming,
  onRequestDelete,
  onConfirmDelete,
  onCancel,
  pending,
  failed,
}: {
  session: WireSessionSummary;
  confirming: boolean;
  /** The trash icon was tapped — opens the confirm step, sends nothing yet. */
  onRequestDelete: () => void;
  /** "Delete permanently" was tapped while already confirming — sends the DELETE. */
  onConfirmDelete: () => void;
  onCancel: () => void;
  pending: boolean;
  failed: boolean;
}) {
  if (confirming) {
    return (
      <li className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <p className="text-sm text-foreground">
          {/* Stated rather than asked: a Session's title is derived from its first Question, so
              it almost always ends in "?" — phrasing this as a question rendered it as ..."?"? */}
          Deleting "{session.title}" is permanent, and removes the Conversation from every Device —
          not just this one.
        </p>
        {failed && (
          <p className="text-xs text-destructive">
            Couldn't delete this Session. Check your Server and try again.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onConfirmDelete}
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete permanently"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-1">
      <Link
        to={`/reflect/${session.id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted"
      >
        <span className="truncate text-sm font-medium">{session.title}</span>
        <span className="text-xs text-muted-foreground">{formatLastUsed(session.updated_at)}</span>
      </Link>
      <button
        type="button"
        aria-label={`Delete "${session.title}"`}
        onClick={onRequestDelete}
        // A separate sibling control, not nested inside the Link above —
        // deleting is its own action, not part of opening the Session, and
        // a button inside an <a> is both invalid HTML and a tap-target trap
        // on a touch device. Muted-to-destructive on hover, distinct from
        // every other icon control in the app bar (nav.tsx) which only ever
        // goes muted-to-foreground: this is the one control anywhere that
        // destroys something.
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
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
  const queryClient = useQueryClient();

  // Issue #64's Search: plain local state, not a URL param or a
  // sessionStorage backup like `use-history-search.ts`'s. That machinery
  // exists to survive a round trip through Settings between two pages that
  // share one thread (Composer and History). Sessions is a single page with
  // no such round trip to survive, and nothing here makes a narrowed list
  // worth linking to or restoring after a reload — so the simplest thing
  // that could work is what's built: a query that resets to empty the next
  // time this page is opened, exactly like `confirmingId` below.
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const searching = debouncedQuery.trim() !== "";

  const sessionsQuery = useQuery({
    // Extends SESSIONS_QUERY_KEY rather than replacing it, so
    // `deleteMutation`'s `invalidateQueries({ queryKey: SESSIONS_QUERY_KEY })`
    // below (a prefix match, TanStack Query's default) still invalidates
    // whichever search is active, the same way `use-entry-search.ts`
    // extends `ENTRIES_QUERY_KEY` for the same reason.
    queryKey: [...SESSIONS_QUERY_KEY, debouncedQuery],
    queryFn: () => sessionsListTransport(debouncedQuery),
    enabled: syncEnabled,
    // Keeps the previous result on screen while a new keystroke's fetch is
    // in flight, rather than flashing the loading state on every edit —
    // `use-entry-search.ts`'s `placeholderData` does the same for History's
    // local search.
    placeholderData: (previous) => previous,
  });

  const result = sessionsQuery.data;
  const loading = syncEnabled && sessionsQuery.isPending;
  const unreachable = result !== undefined && !result.ok;
  const sessions = result?.ok ? result.sessions : [];

  // At most one row's confirm step is open at a time — tapping a second
  // row's trash icon closes whichever one was already open, the same "one
  // thing at a time" rule Shell's own search mode follows.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Which Session's delete most recently failed, independent of
  // `confirmingId` reaching zero: a failure must not silently close the
  // confirm step and make the row look untouched (ADR 0013's write path —
  // a failed write is surfaced, not swallowed), so this stays set until the
  // reader either retries successfully or cancels.
  const [failedId, setFailedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => sessionsDeleteTransport(sessionId),
    onSuccess: (deleteResult, sessionId) => {
      // Issue #80: if the Session just deleted is the one `last-session.ts`
      // remembers, that memory is now dangling — a later bare `/reflect`
      // would try to resume straight into the "not found" case this same
      // ticket also teaches Reflection to handle silently, but there's no
      // reason to let it happen at all when the deletion is known to have
      // succeeded right here. Covers both ways a Session ends up actually
      // gone: this Device's own successful DELETE, and `"not-found"` (it
      // was already gone, likely deleted from another Device) — not the
      // server-error `else` branch below, where the Session is still there.
      const sessionIsGone = deleteResult.ok || deleteResult.reason === "not-found";
      if (sessionIsGone && readLastSessionId() === sessionId) {
        clearLastSessionId();
      }
      if (deleteResult.ok) {
        setFailedId(null);
        setConfirmingId(null);
        // The list is the only thing this page mirrors from the Server
        // (ADR 0025) — invalidating it is what makes the deleted row
        // disappear, the same TanStack Query write path `use-history.ts`'s
        // send mutation already uses. `["session", sessionId]` is also
        // invalidated even though no query with that key is ever active
        // here: it's `reflection-page.tsx`'s own key for `GET
        // /v1/sessions/:id` (ADR 0025), so if a reader returns to this
        // Session's `/reflect/<id>` — e.g. the browser's own Back button,
        // popped past this list — its query is already stale rather than
        // relying on the default `staleTime: 0` alone, and refetches
        // straight into the "This Conversation could not be found" state
        // that page already renders, instead of flashing the Conversation
        // this Device still has cached for a moment first.
        queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      } else if (deleteResult.reason === "not-found") {
        setFailedId(null);
        setConfirmingId(null);
        // Already gone — almost certainly deleted on another Device, which
        // is an ordinary thing to happen now that the Server holds Sessions
        // and every Device reaches the same ones (ADR 0025). The user asked
        // for this Session to not exist and it does not exist, so this is
        // not a failure: reporting a Server error here would blame a Server
        // that is working, and skipping the invalidate would leave the
        // phantom row on screen — the one outcome that actually looks broken.
        queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      } else {
        setFailedId(sessionId);
        toast.error("Couldn't delete this Session. Check your Server and try again.");
      }
    },
    onError: (_error, sessionId) => {
      setFailedId(sessionId);
      toast.error("Couldn't delete this Session. Check your Server and try again.");
    },
  });

  // A real history pop, the same shape settings-page.tsx uses (ADR 0019) and
  // for the same reason: Sessions is reached *from* somewhere — usually the
  // open Conversation whose app bar you tapped — and a fixed `to="/reflect"`
  // would drop a reader who arrived from `/reflect/<id>` into a fresh empty
  // Session instead of the Conversation they left. `location.key ===
  // "default"` means there is nothing behind us to pop (see settings-page's
  // own comment for why that check and not `window.history.length`), and
  // `/reflect` is the right floor for this page specifically.
  function goBack() {
    if (location.key === "default") {
      navigate("/reflect");
    } else {
      navigate(-1);
    }
  }

  return (
    <Shell
      title="Sessions"
      back={
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          // size-11 (44px) tap-target and hover treatment, same as every
          // other app-bar icon control in this app (see nav.tsx's
          // SessionsLink).
          className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
      }
      // Issue #80: the same New Session control Reflect's own app bar
      // shows (reflection-page.tsx), reachable here too — this list is one
      // of the two places acceptance criteria calls for it, since a reader
      // browsing old Sessions is exactly someone who might want to start a
      // new one without first opening one of the old ones.
      action={<NewSessionLink />}
      nav={<Nav />}
      // Issue #64: the same Shell search slot History and the Composer
      // already use, `label` set to "Sessions" — see ShellSearchConfig's own
      // comment for why the label must not read "History" here. Sync being
      // off (below) hides Sessions entirely, so this is only reachable once
      // there's a Server to search against, the same gate the fetch itself
      // is behind.
      search={
        syncEnabled
          ? {
              query,
              onQueryChange: setQuery,
              onDismiss: () => setQuery(""),
              label: "Sessions",
            }
          : undefined
      }
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

      {syncEnabled && !loading && !unreachable && sessions.length === 0 && !searching && (
        <p className="text-center text-sm text-muted-foreground">
          No Sessions yet — ask a Question in Reflect to start one.
        </p>
      )}

      {/* Issue #64: a search that matches nothing must read as "nothing
          matched", not as "you have no Sessions" — the empty state above
          says the latter and would be actively misleading here, since
          Sessions plainly do exist; this one just didn't find any. */}
      {syncEnabled && !loading && !unreachable && sessions.length === 0 && searching && (
        <p className="text-center text-sm text-muted-foreground">
          No Sessions match "{debouncedQuery.trim()}".
        </p>
      )}

      {syncEnabled && !loading && !unreachable && sessions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              confirming={confirmingId === session.id}
              pending={deleteMutation.isPending && deleteMutation.variables === session.id}
              failed={failedId === session.id}
              onRequestDelete={() => {
                // Opens the confirm step; sends nothing yet — the whole
                // point of the two-step (issue #63's acceptance criteria:
                // "behind a confirm step"). Switching to a different row's
                // confirm also clears any stale failure banner left over
                // from a previous attempt on another Session.
                setConfirmingId(session.id);
                setFailedId(null);
              }}
              onConfirmDelete={() => deleteMutation.mutate(session.id)}
              onCancel={() => {
                setConfirmingId(null);
                setFailedId(null);
              }}
            />
          ))}
        </ul>
      )}
    </Shell>
  );
}
