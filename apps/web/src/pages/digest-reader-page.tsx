import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { inlineProse } from "@/components/inline-prose";
import { ServerUnreachableBanner } from "@/components/server-unreachable-banner";
import { Shell } from "@/components/shell";
import { formatDigestProvenance, formatDigestRange, formatStaleCopy } from "@/lib/digest-format";
import { digestAtTransport, digestRegenerateTransport } from "@/lib/digest-transport";
import { digestAtQueryKey, digestQueryKey } from "@/lib/query-keys";
import { refreshCapabilities, useServerReachable, useSyncEnabled } from "@/lib/settings";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = { day: "Day", week: "Week", month: "Month" };

/**
 * The wire's plain `period` string, titled for the reader — "Day" reads
 * oddly as a page title on its own, so this is `"{Label} Digest"` rather
 * than the bare Period name. Falls back to the raw segment for a `period`
 * this page doesn't recognise (a stale link, or a future Period this
 * client predates) rather than rendering nothing — the date range that
 * follows still identifies which one this is either way.
 */
function periodTitle(period: string): string {
  return `${LABELS[period] ?? period} Digest`;
}

/**
 * One back or forward control (issue #72). `date` is whichever of the
 * Digest's own `prev_date`/`next_date` this control steps to — the Server
 * already resolved it to the neighbouring Digest of this Period that
 * actually exists, skipping any Period that has no Digest
 * (`server/src/digest.rs::build_digest_response`'s `select_prev_digest_date`
 * / `select_next_digest_date`). This component therefore never computes a
 * date, adds or subtracts a day, or checks whether a Period is empty — it
 * only ever follows the date it is handed, so it is structurally impossible
 * for a step to land on a gap: the Server has already removed every gap
 * from the sequence before this ever renders.
 *
 * `date: null` (or the `undefined` the generated wire type also allows for
 * an optional field) means there is no neighbour in that direction — the
 * oldest Digest of this Period has no `prev_date`, the newest has no
 * `next_date` — and the control renders disabled rather than vanishing: a
 * control that disappears at the edge of the archive reads as a bug, a
 * disabled one reads as "you've reached the end." It's a real `<button
 * disabled>`, not a `<Link>` merely styled to look grey, so it is inert for
 * keyboard, screen reader and click alike, not just visually muted.
 *
 * Otherwise this is a `<Link>`, the same navigation primitive
 * `digest-page.tsx`'s cards already use to open a Digest, not
 * `navigate(..., { replace: true })` — for two reasons. First, it's the
 * accessible default: a real anchor gets middle-click/open-in-new-tab and a
 * visible href for free, neither of which a click handler calling
 * `navigate` would have. Second, and load-bearing for this ticket's own
 * acceptance criteria ("browser back walks the steps"): `<Link>` pushes a
 * new history entry per step, where `replace: true` would overwrite the
 * entry behind it — so back would jump straight out of the Digest archive
 * instead of walking back through the Digests just visited.
 *
 * Stepping is navigation by URL — ADR 0025 made exactly this call for
 * Sessions ("the Session id lives in the URL, and the URL is the only
 * state"): reloading an open Digest must land on the same one, and browser
 * back from an open Digest must return to the cards. A step that only
 * updated in-page state (instead of visiting `/digest/{period}/{date}`)
 * would break both of those the moment the reader reloaded mid-archive.
 */
function DigestStepControl({
  period,
  date,
  label,
  Icon,
}: {
  period: string;
  date: string | null | undefined;
  label: "Previous Digest" | "Next Digest";
  Icon: typeof ChevronLeft;
}) {
  // Shared with `Nav`'s/`SessionsLink`'s own icon-control idiom
  // (`components/nav.tsx`): `size-11` (44px) is this codebase's tap-target
  // minimum, applied here to a stepping control for the same reason it's
  // applied to a nav destination — a thumb has to hit it reliably.
  const className =
    "flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  if (date == null) {
    return (
      <button
        type="button"
        disabled
        aria-label={label}
        className={`${className} disabled:pointer-events-none disabled:opacity-40`}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
    );
  }

  return (
    <Link to={`/digest/${period}/${date}`} aria-label={label} className={className}>
      <Icon aria-hidden="true" className="size-4" />
    </Link>
  );
}

/**
 * The app-bar Regenerate action (issue #132 / ADR 0039) — the reader's
 * only rescue for a Period stuck past `digest.rs::MAX_ATTEMPTS` (a
 * process-local attempt cap, ADR 0027:155-159 accepts it's lost on
 * restart, so a permanently failed Period never earns a row on its own).
 * **Always enabled**, deliberately never reading `stale` at all — a
 * reader who wants a fresh take on a Period that changed since it was
 * written, or who is simply rescuing one that was never written, has the
 * same one action to reach for either way.
 *
 * Synchronous, and `mutation.isPending` is the only thing this component
 * disables on — the request genuinely takes as long as `digest.rs`'s own
 * inline chat call does (`regenerate_digest_handler` is not a "kick off a
 * background job" endpoint), so a spinner in place of the icon is honest
 * feedback, not decoration, and disabling the button while it spins is
 * about not firing a second overlapping request, never about staleness.
 *
 * On success, invalidates both `digestQueryKey(period)` (the cards page)
 * and `digestAtQueryKey(period, date)` (this page's own query) — issue
 * #132's "reading a Digest after regeneration returns the new body
 * without a manual refresh" acceptance criterion. `digestAtTransport`'s
 * own query already refetches the instant its key is invalidated
 * (TanStack Query's default), so nothing here has to touch `query.data`
 * directly.
 */
function RegenerateAction({ period, date }: { period: string; date: string }) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => digestRegenerateTransport(period, date),
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: digestQueryKey(period) });
        queryClient.invalidateQueries({ queryKey: digestAtQueryKey(period, date) });
      } else {
        toast.error("Couldn't regenerate this Digest. Check your Server and try again.");
      }
    },
    onError: () => {
      toast.error("Couldn't regenerate this Digest. Check your Server and try again.");
    },
  });

  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      aria-label="Regenerate"
      className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
    >
      <RefreshCw
        aria-hidden="true"
        className={cn("size-4", mutation.isPending && "animate-spin")}
      />
    </button>
  );
}

// `/digest/:period/:date` — opens one specific Digest (issue #71's "tapping
// a card opens that Digest"), extended by issue #72 with the back/forward
// controls (`DigestStepControl` below) that walk to the neighbouring
// Digests of the same Period, one route change at a time.
//
// Lives inside `EntryStoreLayout` alongside `/digest` (see App.tsx's
// comment on that route) for the same reason `digest-page.tsx` does: it
// reads nothing from the Entry store, but the layout is what drives Sync,
// and a reader parked on one Digest must not stop syncing either.
//
// The four states mirror `digest-page.tsx`'s exactly, adapted from a list
// of three cards to one Digest: Sync off, Server unreachable, Server too
// old to have Digest routes, and "nothing written yet at this exact date" —
// the last of these reads differently here than on the cards page, since a
// reader who followed a link to a specific date already knows a Digest
// existed there once; see its own copy below.
export function DigestReaderPage() {
  const syncEnabled = useSyncEnabled();
  // Issue #133: as on `digest-page.tsx`, gates further fetches while the
  // Server is known unreachable, so a failed background refetch (a window
  // refocus, a reconnect event) can't silently overwrite an
  // already-successful `DigestResult` in the query cache with a failure
  // one — see that page's own comment on `DigestCards` for the mechanics
  // (`digestAtTransport` never throws, so a failed refetch is new data to
  // TanStack Query, not an error). Also drives the persistent banner below,
  // ORed with the ordinary per-result `unreachable` check (a non-404 error
  // status is "unreachable" here too, even though the Server did answer).
  const serverReachable = useServerReachable();
  const { period, date } = useParams<{ period: string; date: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const query = useQuery({
    // `period ?? ""` / `date ?? ""` rather than a non-null assertion —
    // mirrors `reflection-page.tsx`'s own `sessionId ?? ""`: `enabled`
    // below already means this never runs while either is undefined, so
    // the key only has to be distinct, not meaningful.
    queryKey: digestAtQueryKey(period ?? "", date ?? ""),
    queryFn: () => digestAtTransport(period ?? "", date ?? ""),
    enabled: syncEnabled && period !== undefined && date !== undefined && serverReachable,
  });

  const result = query.data;
  const notSupported = result !== undefined && !result.ok && result.reason === "not-supported";
  const unreachable =
    !notSupported &&
    ((result !== undefined && !result.ok && result.reason === "unreachable") || !serverReachable);
  const digest = result?.ok ? result.digest : undefined;

  // Reached only from `digest-page.tsx`'s own cards, so `/digest` is
  // always the right floor — mirrors `sessions-page.tsx`'s `goBack`
  // exactly, including the same `location.key === "default"` check for
  // "nothing behind us to pop" (see that page's own comment for why not
  // `window.history.length`).
  function goBack() {
    if (location.key === "default") {
      navigate("/digest");
    } else {
      navigate(-1);
    }
  }

  return (
    <Shell
      title={period ? periodTitle(period) : "Digest"}
      back={
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
      }
      // Issue #132 / ADR 0039: only once this route actually names a
      // Period and a date — `notSupported` (this Server has no Digest
      // routes at all) also hides it, the same reasoning `!syncEnabled`
      // already hides the whole page's content for: there is nothing this
      // action could do on a Server that can't serve `/v1/digests/*` at
      // all. Rendered whether or not a Digest exists yet at this date —
      // that "nothing here yet" case is exactly the rescue this action
      // exists for (see `RegenerateAction`'s own doc comment).
      action={
        syncEnabled && !notSupported && period !== undefined && date !== undefined ? (
          <RegenerateAction period={period} date={date} />
        ) : undefined
      }
    >
      {!syncEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to see your Digests.
        </p>
      )}

      {syncEnabled && notSupported && (
        <p className="text-center text-sm text-muted-foreground">
          This Server doesn't support Digests yet.
        </p>
      )}

      {syncEnabled && unreachable && (
        // Issue #133: a persistent banner with a Retry, same as
        // `digest-page.tsx` — see that page's own comment on
        // `ServerUnreachableBanner` for why this replaces what used to be
        // a plain, one-off paragraph.
        <ServerUnreachableBanner
          message="Couldn't load this Digest. Check your Server and try again."
          onRetry={() => {
            refreshCapabilities();
          }}
        />
      )}

      {syncEnabled && result?.ok && digest === null && (
        // Distinct from the cards page's own empty copy: a reader here
        // followed a link to one exact date, so "nothing written yet" would
        // be a lie — the honest read is that this particular Digest was
        // never written (a completed Period this Device once linked to
        // from a now-stale bookmark, or a Digest that failed every retry —
        // `server/src/digest.rs::MAX_ATTEMPTS`).
        <p className="text-center text-sm text-muted-foreground">
          No Digest was written for this date.
        </p>
      )}

      {syncEnabled && digest && (
        <>
          <div className="flex items-center justify-between">
            <DigestStepControl
              period={digest.period}
              date={digest.prev_date}
              label="Previous Digest"
              Icon={ChevronLeft}
            />
            <p className="text-sm text-muted-foreground">
              {formatDigestRange(digest.period, digest.period_start, digest.period_end)}
            </p>
            <DigestStepControl
              period={digest.period}
              date={digest.next_date}
              label="Next Digest"
              Icon={ChevronRight}
            />
          </div>
          {/*
            The provenance cue (issue #132 / ADR 0039): which revision this
            is and when it was written, drawn from `digest.revision`/
            `digest.written_at` — see `formatDigestProvenance`'s own doc
            comment. Rendered above the body, below the stepper row, so it
            reads as a property of *this* revision rather than of the
            Period the stepper above it is walking through.
          */}
          <p className="text-center text-xs text-muted-foreground">
            {formatDigestProvenance(digest.revision, digest.written_at)}
          </p>
          {digest.stale && (
            // Neutral, never an error — see `formatStaleCopy`'s own doc
            // comment citing CONTEXT.md's *Sync status* precedent. Styled
            // identically to the provenance cue just above it (same muted
            // tone, same size): staleness is one more fact about this
            // revision, not a warning that needs to stand out from it.
            <p className="text-center text-xs text-muted-foreground">
              {formatStaleCopy(digest.period)}
            </p>
          )}
          <p className="whitespace-pre-wrap text-sm text-foreground">{inlineProse(digest.body)}</p>
        </>
      )}

      {/* `digest === null` (the branch above) has no `prev_date`/`next_date`
          to step with — there is no Digest at this date at all, let alone a
          neighbour of it, so no stepping row renders there. That already
          reads as "nothing here yet," not as a missing control: the
          "No Digest was written for this date" copy above already says why
          there's nothing to step through, and a copy of these two disabled
          buttons under it would just repeat that without adding anything
          they aren't already following one row up. */}
    </Shell>
  );
}
