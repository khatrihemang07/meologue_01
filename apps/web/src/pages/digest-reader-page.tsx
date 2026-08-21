import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Nav } from "@/components/nav";
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

// `/digest/:period/:date` — opens one specific Digest (issue #71's "tapping
// a card opens that Digest"). Deliberately minimal: the Period and its
// date range as the title, and the full prose beneath it. **No back/forward
// stepping between neighbouring Digests here** — `Digest.prev_date`/
// `next_date` (server/src/digest.rs) exist on the wire already, but wiring
// them into stepping controls is issue #72, the next ticket; this page
// fetches them anyway (they ride along on `WireDigest`) and simply doesn't
// render anything from them yet.
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
      nav={<Nav />}
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
          <p className="text-sm text-muted-foreground">
            {formatDigestRange(digest.period, digest.period_start, digest.period_end)}
          </p>
          <p className="whitespace-pre-wrap text-sm text-foreground">{digest.body}</p>
        </>
      )}
    </Shell>
  );
}
