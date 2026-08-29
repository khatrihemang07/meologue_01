import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Shell } from "@/components/shell";
import { formatDigestRange } from "@/lib/digest-format";
import { digestAtTransport } from "@/lib/digest-transport";
import { digestAtQueryKey } from "@/lib/query-keys";
import { useSyncEnabled } from "@/lib/settings";

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
    enabled: syncEnabled && period !== undefined && date !== undefined,
  });

  const result = query.data;
  const notSupported = result !== undefined && !result.ok && result.reason === "not-supported";
  const unreachable = result !== undefined && !result.ok && result.reason === "unreachable";
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
        <p className="text-center text-sm text-muted-foreground">
          Couldn't load this Digest. Check your Server and try again.
        </p>
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
          <p className="whitespace-pre-wrap text-sm text-foreground">{digest.body}</p>
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
