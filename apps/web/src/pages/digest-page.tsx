import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Nav } from "@/components/nav";
import { Shell } from "@/components/shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDigestRange } from "@/lib/digest-format";
import { type DigestResult, digestTransport } from "@/lib/digest-transport";
import { digestQueryKey } from "@/lib/query-keys";
import { useSyncEnabled } from "@/lib/settings";

/**
 * The three cards this page opens on, in reading order — issue #71's
 * acceptance criteria fixes both the set and the order: last day, last
 * week, last month. `emptyCopy` is Period-specific rather than one shared
 * sentence, because "nothing written yet" means something different at
 * each granularity (see the ticket brief: this is what a fresh install
 * sees for its first day, and for up to a month on this last card) — the
 * words have to say that plainly rather than read as broken.
 */
const PERIODS = [
  {
    period: "day",
    label: "Last day",
    emptyCopy: "No daily Digest yet — one is written the day after you write.",
  },
  {
    period: "week",
    label: "Last week",
    emptyCopy: "No weekly Digest yet — one is written once your first week is complete.",
  },
  {
    period: "month",
    label: "Last month",
    emptyCopy: "No monthly Digest yet — one is written once your first month is complete.",
  },
] as const;

/**
 * One card: the Period's label, the real date or date range it covers
 * (`formatDigestRange` — "the date tells the truth," per the ticket brief,
 * which is why this is computed from `period_start`/`period_end` rather
 * than trusted to match the label's own rhythm), and a two-line teaser of
 * the prose. `Card`/`CardHeader`/`CardTitle`/`CardDescription`/
 * `CardContent` (components/ui/card.tsx) rather than the hand-rolled row
 * idiom `sessions-page.tsx` uses for its list — a Digest genuinely reads as
 * a card, one distinct block per Period, rather than a row in a longer
 * list the way a Session is; this is also this primitive's first use
 * anywhere in the app, and this is exactly the shape it was built for.
 * The whole card is the tap target, wrapped in a single `<Link>` per the
 * ticket, rather than a title-only link with a separate content region —
 * "tapping a card opens that Digest" (issue #71), not tapping a headline.
 *
 * Takes its `result` as a prop rather than querying itself — `DigestCards`
 * below is what owns the three fetches (this codebase's convention: pages
 * own data access, components take props — see composer-page.tsx), both
 * because it needs
 * all three results at once to decide the page-level unreachable/
 * not-supported states, and so this card never opens a second, redundant
 * subscription to a query `DigestCards` already holds.
 */
function DigestCard({
  label,
  emptyCopy,
  period,
  result,
}: {
  label: string;
  emptyCopy: string;
  period: (typeof PERIODS)[number]["period"];
  result: DigestResult | undefined;
}) {
  // A card that hasn't resolved yet (or failed) renders nothing of its
  // own — the page-level states in `DigestCards` (`unreachable`/
  // `notSupported`) already cover every failure uniformly, since all three
  // cards share the one Server connection; a per-card retelling of the
  // same failure three times over would be noise, not information.
  if (result === undefined || !result.ok) {
    return null;
  }

  if (result.digest === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{label}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{emptyCopy}</p>
        </CardContent>
      </Card>
    );
  }

  const { digest } = result;

  return (
    <Link
      to={`/digest/${period}/${digest.period_start}`}
      className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="transition-colors hover:bg-muted/60">
        <CardHeader>
          <CardTitle>{label}</CardTitle>
          <CardDescription>
            {formatDigestRange(period, digest.period_start, digest.period_end)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="line-clamp-2 text-sm text-muted-foreground">{digest.body}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

// `/digest` — the fourth persistent nav destination (issue #71, amending
// ADR 0020's destination count from three to four; see docs/adr/0020's own
// amendment note and docs/adr/0027 for how these Digests get written in
// the first place). Reads nothing from the Entry store — a Digest lives
// only on the Server, fetched fresh on open, nothing cached beyond
// TanStack Query's own default lifetime and nothing to reconcile,
// following ADR 0025's grain exactly, the same as `sessions-page.tsx`
// reading nothing from the store either. It still renders inside
// `EntryStoreLayout` (see App.tsx's comment on that route), because that
// layout is what drives Sync — a reader parked here must not stop
// syncing just because this page never touches Entries directly.
//
// Gated on Sync being on, for the same reason `reflection-page.tsx` and
// `sessions-page.tsx` are: a Digest is written by the Server from Entries
// Sync put there, so a Device with no Server URL has nothing to fetch —
// and in that state no request is made at all (`enabled: syncEnabled`
// inside `DigestCard`'s query would be the naive fix, but the three cards
// below simply don't mount while `!syncEnabled`, which is the stronger
// guarantee the ticket actually asks for).
export function DigestPage() {
  const syncEnabled = useSyncEnabled();

  return (
    // No `action` slot (issue #75): Settings is a Nav destination now, not
    // an app-bar gear — see nav.tsx's DESTINATIONS.
    <Shell title="Digest" nav={<Nav />}>
      {!syncEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to see your Digests.
        </p>
      )}

      {syncEnabled && <DigestCards />}
    </Shell>
  );
}

/**
 * Split out from `DigestPage` so the three `useQuery` calls below never
 * mount while Sync is off — `enabled: false` on a query still constructs
 * the query and would still show up in a cache inspector, but a component
 * that never renders makes "no request is made at all" (the ticket's own
 * wording) true by construction rather than by a flag on each query.
 */
function DigestCards() {
  const dayQuery = useQuery({
    queryKey: digestQueryKey("day"),
    queryFn: () => digestTransport("day"),
  });
  const weekQuery = useQuery({
    queryKey: digestQueryKey("week"),
    queryFn: () => digestTransport("week"),
  });
  const monthQuery = useQuery({
    queryKey: digestQueryKey("month"),
    queryFn: () => digestTransport("month"),
  });

  const results: Record<(typeof PERIODS)[number]["period"], DigestResult | undefined> = {
    day: dayQuery.data,
    week: weekQuery.data,
    month: monthQuery.data,
  };
  const flatResults = [results.day, results.week, results.month];
  // A 404 (this Server has no Digest routes at all) beats an ordinary
  // network failure in priority: both are possible readings of "some
  // requests failed and some didn't" if a caller raced Settings mid-flight,
  // but "too old to have these routes" is the more specific, more useful
  // thing to tell a reader when it's true.
  const notSupported = flatResults.some(
    (result) => result !== undefined && !result.ok && result.reason === "not-supported",
  );
  const unreachable =
    !notSupported &&
    flatResults.some(
      (result) => result !== undefined && !result.ok && result.reason === "unreachable",
    );

  if (notSupported) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        This Server doesn't support Digests yet.
      </p>
    );
  }

  if (unreachable) {
    // ADR 0025 requires an outage to say so rather than render as empty —
    // the same rule `sessions-page.tsx` and `reflection-page.tsx` already
    // follow for their own Server-backed reads.
    return (
      <p className="text-center text-sm text-muted-foreground">
        Couldn't load your Digests. Check your Server and try again.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {PERIODS.map(({ period, label, emptyCopy }) => (
        <DigestCard
          key={period}
          period={period}
          label={label}
          emptyCopy={emptyCopy}
          result={results[period]}
        />
      ))}
    </div>
  );
}
