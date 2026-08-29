import { useQuery } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { BackToChats } from "@/components/back-to-chats";
import { HistoryScrollContext, Shell } from "@/components/shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDigestRange } from "@/lib/digest-format";
import { type DigestResult, digestTransport } from "@/lib/digest-transport";
import { allocateLineBudgets } from "@/lib/proportional-clamp";
import { digestQueryKey } from "@/lib/query-keys";
import { useSyncEnabled } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * The fewest lines a clamped Digest is cut to. Below this a card stops being
 * a teaser of what the Server wrote and becomes a fragment — and the reader
 * can no longer tell the three Periods apart by what they actually say,
 * which is the only reason to show three at once rather than one.
 */
const MIN_CLAMPED_LINES = 3;

/**
 * Shell's own content padding (`py-4`), which sits below this page's last
 * card and is not part of the space the cards may fill. Named rather than
 * folded into the arithmetic below: it is a number this file has to keep in
 * step with `shell.tsx`, and a bare 16 in a subtraction says nothing about
 * that.
 */
const SHELL_CONTENT_BOTTOM_PADDING_PX = 16;

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
  maxBodyHeight,
  bodyRef,
}: {
  label: string;
  emptyCopy: string;
  period: (typeof PERIODS)[number]["period"];
  result: DigestResult | undefined;
  /**
   * How tall this card's prose may be, in px, or null for "as tall as it
   * wants". Always a whole number of lines (`DigestCards` computes it from
   * the measured line height), which is what keeps a clamp from leaking a
   * sliver of the next line through underneath the last one — the specific
   * defect the old `line-clamp-2` produced.
   */
  maxBodyHeight: number | null;
  bodyRef: (node: HTMLParagraphElement | null) => void;
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
          {/*
            The clamp is a `max-height` on this wrapper, not `line-clamp` on
            the prose itself. Two reasons, and both were defects here before:
            `line-clamp` reports its own clamped height back through
            `scrollHeight`, so the measurement below could never see what the
            prose actually needed once it had been cut once; and its ellipsis
            sat at the end of the last visible line with a sliver of the next
            one showing through beneath it. A whole number of lines with the
            overflow hidden shows only whole lines, and the affordance under
            it says there is more rather than a "…" implying it.
          */}
          <div className="overflow-hidden" style={{ maxHeight: maxBodyHeight ?? undefined }}>
            <p ref={bodyRef} className="text-muted-foreground text-sm">
              {digest.body}
            </p>
          </div>
          {/*
            Kept in flow at every size, and only made invisible when there is
            nothing more to read — `invisible` (`visibility: hidden`), never
            `display: none`. The measurement below reads the space this card
            spends on everything that is not prose; a footer that appeared and
            disappeared would change that number in the middle of settling on
            it. `history.tsx`'s always-present day pill is the same trick for
            the same reason. `visibility: hidden` also takes it out of the
            accessibility tree, so it is not announced on a card with nothing
            hidden behind it.
          */}
          <p
            aria-hidden={maxBodyHeight === null}
            className={cn(
              "mt-2 font-medium text-foreground text-xs",
              maxBodyHeight === null && "invisible",
            )}
          >
            Read the rest
          </p>
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
    <Shell title="Digest" back={<BackToChats />}>
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

/**
 * How much of each Digest fits (#128).
 *
 * Three cards used to clamp to two lines each while more than half the
 * screen sat empty below them. Now nothing is clamped at all while the three
 * fit one screen, and only when they overflow does anything get cut — each
 * proportionally to what it actually needs, and always to a whole number of
 * lines.
 *
 * Everything here is measured rather than assumed. The line height comes off
 * the rendered prose, not from a constant that would have to be kept in step
 * with a Tailwind class; the space a card spends on things that are not prose
 * (its title, its date range, its padding, the affordance under it) is the
 * difference between what the container occupies and what the prose inside it
 * does, so no part of the card's own layout is duplicated here as arithmetic.
 *
 * The fallback is "clamp nothing". With no scroll element yet, or one that
 * has not been measured (jsdom, and a real browser's first few frames before
 * its first ResizeObserver callback), every card renders at its natural
 * height — the same shape of benign fallback `history.tsx` uses for the same
 * situation, and the right way round: a Digest showing too much of itself is
 * a page that scrolls, where one showing too little is prose the reader
 * cannot get at.
 */
function useFittedDigests() {
  // Shell owns the scroll region, and it is the only thing that knows how
  // tall the visible page actually is. Reached through the same context
  // `history.tsx` uses for it — named for History, but it is the shell's
  // scroll element, and a second way to find the same node would be a second
  // thing to keep correct.
  const { scrollElement } = useContext(HistoryScrollContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const bodiesRef = useRef<(HTMLParagraphElement | null)[]>([]);
  const [maxBodyHeights, setMaxBodyHeights] = useState<(number | null)[]>(() =>
    PERIODS.map(() => null),
  );

  const registerBody = (index: number) => (node: HTMLParagraphElement | null) => {
    bodiesRef.current[index] = node;
  };

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !scrollElement) return;

    const measure = () => {
      const bodies = bodiesRef.current;
      const firstBody = bodies.find((body) => body !== null && body !== undefined);
      if (!firstBody) return;
      const lineHeight = Number.parseFloat(window.getComputedStyle(firstBody).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

      // `scrollHeight` on the prose itself, which is never the element with
      // the clamp on it — see the card's own comment. So this stays the
      // height the words really want, however many times it has been cut.
      const demands = PERIODS.map((_, index) => {
        const body = bodies[index];
        return body ? Math.round(body.scrollHeight / lineHeight) : 0;
      });

      const proseHeight = PERIODS.reduce((sum, _, index) => {
        const wrapper = bodies[index]?.parentElement;
        return sum + (wrapper?.clientHeight ?? 0);
      }, 0);
      const chromeHeight = container.scrollHeight - proseHeight;
      const availablePx =
        scrollElement.clientHeight -
        container.offsetTop -
        SHELL_CONTENT_BOTTOM_PADDING_PX -
        chromeHeight;
      const available = Math.floor(availablePx / lineHeight);

      const budgets = allocateLineBudgets({ demands, available, minimum: MIN_CLAMPED_LINES });
      const next = budgets.map((lines) => (lines === null ? null : lines * lineHeight));
      setMaxBodyHeights((current) =>
        current.length === next.length && current.every((value, index) => value === next[index])
          ? current
          : next,
      );
    };

    measure();
    // Guarded the same way `use-pinned-scroll.ts` guards its own: jsdom has
    // no ResizeObserver, and this hook's whole failure mode is already
    // "clamp nothing", which is the right outcome there anyway.
    if (typeof ResizeObserver === "undefined") return;
    // The scroll region for the window changing (a rotation, a resize, the
    // pane divider moving), and the container for the prose itself arriving
    // — the three queries do not resolve together, so the first measurement
    // usually runs against fewer than three cards.
    const observer = new ResizeObserver(measure);
    observer.observe(scrollElement);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollElement]);

  return { containerRef, registerBody, maxBodyHeights };
}

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

  const { containerRef, registerBody, maxBodyHeights } = useFittedDigests();

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
    <div ref={containerRef} className="flex flex-col gap-4">
      {PERIODS.map(({ period, label, emptyCopy }, index) => (
        <DigestCard
          key={period}
          period={period}
          label={label}
          emptyCopy={emptyCopy}
          result={results[period]}
          maxBodyHeight={maxBodyHeights[index] ?? null}
          bodyRef={registerBody(index)}
        />
      ))}
    </div>
  );
}
