import type { Entry } from "@meologue/core";
import {
  measureElement as measureElementDefault,
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { DatePickerSheet } from "@/components/date-picker-sheet";
import { EntryActionsSheet } from "@/components/entry-actions";
import { EntryBubble } from "@/components/entry-bubble";
import { entrySnippet } from "@/components/entry-row";
import { HistoryScrollContext } from "@/components/shell";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { useDayReferrers } from "@/hooks/use-day-referrers";
import { useSwipeActions } from "@/hooks/use-swipe-actions";
import { copyText } from "@/lib/clipboard";
import { deviceUtcOffsetMinutes, entryDayKey, formatDaySeparator } from "@/lib/entry-day";
import { cn } from "@/lib/utils";

interface HistoryProps {
  entries: Entry[];
  /**
   * Whether a Server URL is configured (ticket 32). An Entry with `seq ===
   * null` hasn't been assigned a server sequence — the Server has never
   * seen it — but with Sync off that's true of every Entry, so the marker
   * would say nothing except what the capture page's hint already says
   * once.
   */
  syncEnabled: boolean;
  /**
   * The active Search query (ticket 39), for highlighting matched terms in
   * each Entry's body. Absent (or blank) outside History's own search box —
   * the Composer footer renders this same component with no query, and
   * shows every Entry's body plain.
   */
  query?: string;
  /**
   * Wires Edit/Delete/Refer (issue #78, ADR 0028; issue #144) onto every
   * row this renders. All three undefined or all three present, never a
   * partial set — see EntryRow's own `actions` prop, which this assembles
   * (alongside the sheet-open setter below) and forwards. composer-page.tsx's
   * footer, History's one remaining caller since issue #75 deleted
   * `/history`'s own page, passes all three; nothing here defaults a
   * missing one to a no-op, because a silently-broken action is worse than
   * a type error at the call site that forgot one.
   */
  onEdit?: (entry: Entry) => void;
  onDelete?: (entry: Entry) => void;
  /**
   * Puts a Reference to an Entry into the Composer (issue #144) — see this
   * prop group's own comment just above for the all-or-nothing rule it
   * joins onEdit/onDelete under. Unlike Delete, Refer has no confirmation
   * step: `actions.onRefer` below calls straight through to this rather
   * than through a requester.
   */
  onRefer?: (entry: Entry) => void;
  /**
   * Issue #147: the later Entries that Refer to a given local day
   * (day-referrers.ts's own `dayReferrers`) — read from `useEntryStore()`
   * by composer-page.tsx and handed down as a prop rather than read here
   * directly, the same reasoning `seek`'s own trio just below follows for
   * itself: history.test.tsx renders `<History>` bare, with no
   * `EntryStoreLayout`/`Outlet` above it, and this row is unconditional —
   * one per day, regardless of whether any Entry's body has ever been
   * touched — unlike `DateReferenceLink` (entry-row.tsx), which only
   * mounts, and so only calls `useEntryStore()`, when an actual
   * `[[date]]` mark was parsed out of some Entry's body. Reading this
   * context directly here would throw across every existing test in this
   * file the moment a day separator exists at all. Undefined behaves
   * exactly like `useDayReferrers`'s own "no probe" case: the row renders
   * nothing, same as a day confirmed to have no referrers.
   */
  dayReferrers?: (dayKey: string) => Promise<Entry[]>;
  /**
   * Issue #142/#143: the day or Entry a Reference seek (composer-page.tsx)
   * is looking for, or `null`/omitted while no seek is active. History is
   * the only thing that can act on this — it alone owns `flatItems` (below)
   * and the virtualizer that can actually scroll to a row — so
   * composer-page.tsx hands over the target and gets called back rather
   * than trying to reach into either of those itself.
   *
   * A tagged union rather than two independent optional fields: the two
   * kinds converge differently once found (an Entry seek also flashes the
   * row it lands on — see the effect below — a day seek only scrolls), and
   * `kind` is what lets that branch read as "which seek is this" instead of
   * a pair of nullable fields a caller could, in principle, both set at
   * once.
   */
  seek?: HistorySeekTarget | null;
  /**
   * The target day's separator wasn't in `flatItems` on this render.
   * composer-page.tsx owns `pagination` (History does not — see
   * HistoryProps' own shape), so it decides from here whether to load
   * another page or give up: hasMore is false, this same seek has nothing
   * further to check, and composer-page.tsx's own handler calls
   * `onSeekSettled` in that case instead of fetching. History just reports
   * "not found yet" every time that stays true; it does not loop on its
   * own account at all.
   */
  onSeekNeedsOlder?: () => void;
  /** The seek reached its target, or (composer-page.tsx's own call) ran out of older Entries to check. Either way, there is nothing left for this seek to do. */
  onSeekSettled?: () => void;
}

/**
 * What a Reference seek is looking for (see `HistoryProps.seek`'s own
 * comment). Exported so composer-page.tsx — which builds this from `?d=` or
 * `?e=` — and history.test.tsx share the exact shape rather than each
 * re-deriving it structurally.
 */
export type HistorySeekTarget =
  | { kind: "day"; dayKey: string }
  | { kind: "entry"; entryId: string };

// Issue #143: how long a followed Entry Reference's target stays flashed
// once the seek lands on it. Long enough that a reader who was mid-scroll
// notices which row they arrived at; short enough that it reads as a
// momentary flash rather than a mode the row is stuck in.
const SEEK_HIGHLIGHT_DURATION_MS = 1500;

interface DayGroup {
  /** null for an Entry whose createdAt didn't parse — see groupByDay below. */
  dayKey: string | null;
  entries: Entry[];
}

// Groups Entries into runs sharing a local day (ticket 52), via the same
// `entryDayKey` Export's own day-grouping primitive backs (ADR 0016) — this
// is what makes "day grouping matches Export's grouping" true by
// construction rather than by coincidence.
//
// `entries` arrives newest-first (`list()` is `ORDER BY created_at DESC`);
// reversing that to oldest-first reading order is ticket 53's job, not
// this one's, so this groups whatever order it's handed. That's safe
// either way: the input is always time-sorted, and a time-sorted list can
// only leave a calendar day once before entering the next one, so Entries
// sharing a day are always contiguous in the array regardless of
// direction — no need to bucket by key and re-flatten.
//
// An Entry whose createdAt doesn't parse (entryDayKey returns null) gets
// its own single-Entry group with no separator, rather than being folded
// into a neighbouring day it doesn't actually belong to.
function groupByDay(entries: Entry[], offsetMinutes: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const dayKey = entryDayKey(entry.createdAt, offsetMinutes);
    const previous = groups.at(-1);
    if (dayKey !== null && previous !== undefined && previous.dayKey === dayKey) {
      previous.entries.push(entry);
    } else {
      groups.push({ dayKey, entries: [entry] });
    }
  }
  return groups;
}

// The full weekday + date behind a day separator's short label (ticket 52)
// — available on hover, same idea as `formatAbsoluteTime` for a per-Entry
// clock time, just without a time-of-day component since a day key has
// none. `dayKey` is parsed as UTC midnight, matching `formatDaySeparator`'s
// own parse in entry-day.ts, so the two never disagree about which day a
// key names.
// Same fast-path trap as entry-day.ts/entry-time.ts's own formatters
// (issue #81): `toLocaleDateString` with an options bag builds a fresh
// `Intl.DateTimeFormat` per call. This one's options are entirely fixed —
// `timeZone` is always the literal "UTC" here, never a per-call argument —
// so, unlike `formatDaySeparator` next door in entry-day.ts, a single
// lazily-built instance covers every call; no keyed cache needed.
let daySeparatorTitleFormatter: Intl.DateTimeFormat | undefined;
function getDaySeparatorTitleFormatter(): Intl.DateTimeFormat {
  if (daySeparatorTitleFormatter === undefined) {
    daySeparatorTitleFormatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeZone: "UTC",
    });
  }
  return daySeparatorTitleFormatter;
}

function formatDaySeparatorTitle(dayKey: string): string | undefined {
  const parsed = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return getDaySeparatorTitleFormatter().format(parsed);
}

// Issue #83: one flattened row for `@tanstack/react-virtual` to index —
// separators and Entries alike, in reading order, since the virtualizer has
// no notion of "a group" and needs every rendered thing to be one item at
// one index. `key` is what `getItemKey` (below) hands the virtualizer
// instead of the plain array index virtual-core defaults to: prepending an
// older page (issue #79) shifts every existing item's *index* by however
// many rows landed above it, and the virtualizer caches measured sizes by
// whatever `getItemKey` returns — keying by index instead would apply
// yesterday's measured height to a row that used to be at that index and
// no longer is, which is exactly the "overlap, gaps, drift" this ticket's
// acceptance criteria rule out. An Entry's own id is already a stable,
// globally-unique key (CONTEXT.md: minted on the Device that created it);
// a separator's day key is equally stable and, within one flattened list,
// equally unique (groupByDay only ever emits one run per day).
interface FlatSeparatorItem {
  kind: "separator";
  key: string;
  dayKey: string;
}
/**
 * Issue #147: what later Entries Refer to this day — its own row, adjacent
 * to the separator rather than inside it or the sticky pill (see
 * `DayReferrersRow`'s own comment for why: ADR 0030 forbids growing either
 * of those, and the virtualizer measures a row, not a fixed-height
 * wrapper). Emitted alongside every separator in `flattenGroups` below,
 * unconditionally — `DayReferrersRow` itself decides, once its probe
 * resolves, whether there is anything worth a reader seeing here at all.
 */
interface FlatDayReferrersItem {
  kind: "dayReferrers";
  key: string;
  dayKey: string;
}
interface FlatEntryItem {
  kind: "entry";
  key: string;
  entry: Entry;
  /** Which day this row belongs to — null mirrors its group's own unparseable-date case. Read by the always-present pill to know which day the topmost rendered row is in. */
  dayKey: string | null;
  /** True for the first Entry in its group — the one row in each run that gets no divider above it (see the render below, replacing the old `divide-y` wrapper a virtualized list can't use: rows are no longer necessarily adjacent DOM siblings). */
  isFirstInGroup: boolean;
}
type FlatItem = FlatSeparatorItem | FlatDayReferrersItem | FlatEntryItem;

function flattenGroups(groups: DayGroup[]): FlatItem[] {
  const items: FlatItem[] = [];
  for (const group of groups) {
    if (group.dayKey !== null) {
      items.push({ kind: "separator", key: `sep:${group.dayKey}`, dayKey: group.dayKey });
      // Issue #147: right after the separator it belongs to, not before —
      // reads as "this day; here is what refers back to it" in that order.
      items.push({ kind: "dayReferrers", key: `ref:${group.dayKey}`, dayKey: group.dayKey });
    }
    group.entries.forEach((entry, index) => {
      items.push({
        kind: "entry",
        key: entry.id,
        entry,
        dayKey: group.dayKey,
        isFirstInGroup: index === 0,
      });
    });
  }
  return items;
}

// A single-line Entry row's rough height, in px — just a starting guess for
// rows the virtualizer hasn't measured yet (its own `measureElement`, wired
// onto each rendered row below, corrects it against the real, wrapped
// height the instant a row actually renders). Separators render shorter
// than this; that's fine, the same correction applies to them too.
const ESTIMATED_ROW_HEIGHT_PX = 56;

// jsdom lays nothing out — `getBoundingClientRect` is always zero, so the
// scroll element's measured size is always `{width: 0, height: 0}` in every
// test in history.test.tsx (which renders `<History>` with no `<Shell>`
// around it, so there's no real scroll element at all) and in every other
// suite that renders it through `<Shell>` without hand-setting
// `scrollHeight`/`clientHeight` the way shell.test.tsx and
// use-pinned-scroll.test.tsx do for their own, narrower assertions. With a
// zero-size viewport the virtualizer's own range calculation only ever
// wants to render the handful of rows nearest `scrollTop` (see
// `calculateRangeImpl` in `@tanstack/virtual-core`) — `overscan` is what
// pads that range back out regardless of viewport size, so a value at
// least as large as any fixture in this codebase's test suites (the
// largest is a few Entries plus their separators) keeps every row actually
// rendered and queryable under jsdom, the same as before virtualization.
// It's a perfectly reasonable overscan for a real window too — nowhere
// near "render everything," just generous.
const OVERSCAN = 25;

// Bounds the zero-viewport fallback below (its own comment) — reusing
// OVERSCAN's own value rather than inventing a second, independent guess:
// both are answering the same question ("how many rows is it reasonable to
// render without knowing the real viewport size yet"), and OVERSCAN's own
// comment already establishes that this codebase's largest single History
// fixture (a handful of Entries plus their separators) sits comfortably
// inside it. A real History can hold thousands of Entries; without this
// cap, that fallback rendered every one of them on a real browser's very
// first paint (before its first ResizeObserver callback lands) — exactly
// the per-row DOM cost issue #83 exists to remove.
const MAX_FALLBACK_ROWS = OVERSCAN;

/**
 * Issue #147: "a day shows what Refers to it" (ADR 0042's own Context) —
 * the half of the Reference feature that makes a day itself reachable from
 * its future, rather than only letting a new Entry point backwards. Its
 * own row (`FlatDayReferrersItem`), not text squeezed into the separator
 * or the sticky pill: ADR 0030 forbids growing either of those, and this
 * needs to render anywhere from nothing at all up to several links — a
 * range only a row the virtualizer measures on its own can carry.
 *
 * Renders nothing — not an empty state, not a zero count — until `probe`
 * resolves with at least one referrer: both "still resolving" and
 * "confirmed nothing Refers here" render identically, the same "unresolved
 * is invisible" shape `DateReferenceLink`/`EntryReferenceLink` already
 * follow for a single mark, just applied to a whole row instead of one
 * inline chip. `null` costs the row nothing extra: `estimateSize` below
 * already guesses `0` for this item kind, so an empty day never reserves
 * space that would otherwise have to shrink back down once the probe
 * settles — the majority case, since most days have nothing pointing back
 * at them.
 *
 * Opening a referrer reuses the exact seek a followed `[[e:...]]` chip
 * already uses (`?e=<id>`, composer-page.tsx) rather than a second
 * navigation path — the whole reason ADR 0042 put the seek's destination in
 * a query param was so every caller, this one included, could just build
 * the same URL.
 */
function DayReferrersRow({
  dayKey,
  probe,
}: {
  dayKey: string;
  probe: ((dayKey: string) => Promise<Entry[]>) | undefined;
}) {
  const referrers = useDayReferrers(probe, dayKey);
  if (referrers === undefined || referrers.length === 0) {
    return null;
  }
  // Each link carries its own referrer's day and snippet — the same shape
  // `EntryReferenceLink`'s own chip (entry-row.tsx) uses — rather than a
  // bare, identical "open this" for every one: with more than one referrer,
  // an identical accessible name on every link would leave a screen reader
  // unable to tell them apart.
  const offsetMinutes = deviceUtcOffsetMinutes();
  const todayKey = entryDayKey(new Date().toISOString(), offsetMinutes) ?? "";
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 px-4 pb-2 text-xs text-muted-foreground">
      <span>
        {referrers.length === 1
          ? "Referred to by 1 Entry:"
          : `Referred to by ${referrers.length} Entries:`}
      </span>
      {referrers.map((referrer) => {
        const referrerDayKey = entryDayKey(referrer.createdAt, offsetMinutes);
        const dayLabel =
          referrerDayKey === null ? null : formatDaySeparator(referrerDayKey, todayKey);
        return (
          <Link
            key={referrer.id}
            to={`/composer?e=${referrer.id}`}
            aria-label={`Open the Entry from ${dayLabel ?? "an earlier day"} that Refers to this day`}
            className="inline-flex max-w-40 items-baseline gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 underline decoration-dotted underline-offset-2"
          >
            {dayLabel !== null && <span className="shrink-0 font-medium">{dayLabel}</span>}
            <span className="truncate">{entrySnippet(referrer.body)}</span>
          </Link>
        );
      })}
    </div>
  );
}

export function History({
  entries,
  syncEnabled,
  query = "",
  onEdit,
  onDelete,
  onRefer,
  dayReferrers,
  seek,
  onSeekNeedsOlder,
  onSeekSettled,
}: HistoryProps) {
  // The "which Entry is open" state behind the single shared
  // EntryActionsSheet below (issue #78) — owned here, not per-row, which
  // is what keeps exactly one sheet instance in the DOM no matter how many
  // rows this renders. null means closed; a row's tap (touch device) or
  // right-click (pointer device, optional) sets it via onOpenSheet below.
  const [sheetEntry, setSheetEntry] = useState<Entry | null>(null);

  // The Entry awaiting a delete confirmation, or null when no dialog is
  // open (issue #82). It lives here for the same reason `sheetEntry` does:
  // this is the one component above every row, so one dialog serves all of
  // them. Choosing Delete — from a hover button or from the sheet — sets
  // this rather than deleting, and only the dialog's own confirm calls the
  // real `onDelete` below.
  const [confirmEntry, setConfirmEntry] = useState<Entry | null>(null);

  // All-or-nothing (see the props' own comment): assembled once here
  // rather than re-checked per row, and `undefined` when any of the three
  // is missing so EntryRow's own default ("no actions prop" -> "no
  // actions") is what actually governs the no-actions case, instead of
  // this component duplicating that decision. `onOpenSheet` is folded in
  // here rather than being a fourth prop composer-page.tsx has to pass —
  // it's this component's own state setter, not something an outside
  // caller has any business supplying. `onRefer` (issue #144) passes
  // straight through unwrapped, unlike `onDelete`: Refer has no
  // confirmation step to route through first.
  //
  // Memoised (issue #81) so this is the same object across renders whenever
  // `onEdit`/`onDelete`/`onRefer` themselves are: every row below receives
  // `actions` as a prop, and `React.memo` on EntryRow (entry-row.tsx) only
  // skips a row's re-render if every one of its props is `===` the last
  // render's — rebuilding this object inline, as before, would hand every
  // row a fresh `actions` reference each time and defeat that memoisation
  // entirely, even though nothing it points to actually changed.
  const actions = useMemo(
    () =>
      onEdit && onDelete && onRefer
        ? { onEdit, onDelete: setConfirmEntry, onOpenSheet: setSheetEntry, onRefer }
        : undefined,
    [onEdit, onDelete, onRefer],
  );

  // A swipe hands back the element it picked up, not an Entry: the hook is
  // deliberately ignorant of what a row stands for. Resolving the id here
  // reads whatever `entries` is at the moment of the release rather than
  // whatever it was when the listener was attached, which matters because a
  // sync tick can replace the array mid-gesture.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const openSheetForSwipe = useCallback((target: HTMLElement) => {
    const id = target.dataset.entryId;
    const swiped = entriesRef.current.find((candidate) => candidate.id === id);
    if (swiped) setSheetEntry(swiped);
  }, []);
  // The element every bubble is positioned inside, and the one thing the
  // swipe recogniser is attached to (#127) — once, for the whole thread,
  // rather than once per row. A callback ref, because this component's very
  // first render (Entry store still opening) returns early with no row
  // container at all; see `use-swipe-actions.ts` for what that cost.
  const rowsRef = useSwipeActions({
    onOpen: openSheetForSwipe,
    // Nothing to open without Edit/Delete wired up — Grounding renders the
    // same Entries and must stay read-only (EntryRowProps' own comment).
    enabled: actions !== undefined,
  });

  // Copy (#127). The sheet reports the choice; this is where it happens, for
  // the same reason Delete's confirmation lives here — one component above
  // every row. Both outcomes are announced, and differently: a WebView that
  // refuses the clipboard must not be indistinguishable from one that wrote
  // to it, or the reader pastes stale text somewhere else and blames that.
  const copyEntry = useCallback((entry: Entry) => {
    void copyText(entry.body).then((copied) => {
      if (copied) toast.success("Entry copied.");
      else toast.error("Couldn't copy this Entry. Select the text to copy it instead.");
    });
  }, []);

  // Issue #146: which day a tap on either marker opened the picker for, or
  // null while it's closed. Owned here for the same reason `sheetEntry` and
  // `confirmEntry` are above — this is the one component above every marker
  // this thread can render, so one `DatePickerSheet` instance serves both
  // the sticky pill and however many inline separators are mounted, rather
  // than one per marker.
  const [datePickerDayKey, setDatePickerDayKey] = useState<string | null>(null);

  // Confirming a day seeks History to it by the exact route a date
  // Reference already uses (`DateReferenceLink`, entry-row.tsx) — `?d=` is
  // read back by composer-page.tsx into a `seek` prop this same component
  // already knows how to converge on (the effect above), so a tapped day
  // and a followed Reference land through one mechanism, not two.
  const navigate = useNavigate();
  const handleDateConfirm = useCallback(
    (dayKey: string) => {
      navigate(`/composer?d=${dayKey}`);
    },
    [navigate],
  );

  // `groupByDay` is the one genuinely O(entries.length) piece of render-body
  // work here (issue #81) — memoised so a render this component takes for
  // an unrelated reason (e.g. `query` changing, which doesn't affect
  // grouping) doesn't re-walk the whole Entry list. `deviceUtcOffsetMinutes`
  // and `entryDayKey` just below stay un-memoised on purpose: both are O(1)
  // (one `Date` read, one UTC-parts split), so recomputing them every
  // render costs nothing, and it's what keeps `todayKey` correct across a
  // midnight boundary within one session — folding them into the same memo
  // as `groups` (keyed on `entries`) would freeze "Today" as whatever day
  // it was when `entries` last changed, which could be wrong for however
  // long the reader sits on this page with nothing new arriving.
  const offsetMinutes = deviceUtcOffsetMinutes();
  const todayKey = entryDayKey(new Date().toISOString(), offsetMinutes) ?? "";
  const groups = useMemo(() => groupByDay(entries, offsetMinutes), [entries, offsetMinutes]);

  // Issue #83: separators flattened in alongside Entries — see FlatItem's
  // own comment for why this needs a real, stable per-row key rather than
  // just position. Cheap (one pass over what `groups` already computed) and
  // memoised on `groups` alone, the same reasoning as `groups`' own memo
  // just above: a render triggered by something grouping doesn't depend on
  // (`query` changing, say) must not re-walk the Entries a second time.
  const flatItems = useMemo(() => flattenGroups(groups), [groups]);

  // Issue #83: the scroll element and the upward jump-to-newest hookup —
  // see HistoryScrollContext's own comment (shell.tsx) for why both cross
  // this boundary as a context rather than a prop Shell would have to know
  // the shape of.
  const { scrollElement, registerScrollToNewest } = useContext(HistoryScrollContext);

  // The one thing this measures itself, rather than asking Shell for it:
  // how much of *this component's own* rendered content — the
  // always-present day pill below, mainly — sits above the virtualized
  // list, in the same pixel space as the scroll element's own height. A
  // `<div>` with no height of its own placed immediately before the
  // virtualized list's sizer; its `offsetTop`, once real layout has run,
  // is exactly that quantity (relative to Shell's scroll region, which is
  // why that element needs `position: relative` — see its own comment).
  // Deliberately *not* measured from the sizer itself: the sizer's own
  // offsetTop would include this spacer's own height, and this spacer's
  // height is exactly what the calculation below is solving for — a
  // circular measurement that would either read one render stale or (worse)
  // never settle. Marking the boundary with its own, empty, non-circular
  // element sidesteps that entirely.
  const spacerRef = useRef<HTMLDivElement>(null);
  const [contentAboveList, setContentAboveList] = useState(0);
  // No dependency array: re-measures after every commit. Cheap (one
  // `offsetTop` read) and correct however what's above the list changes —
  // the always-present pill appearing/disappearing as the topmost visible
  // day changes, most often. The explicit equality check earns its keep
  // beyond the obvious "skip a pointless render": calling the setter
  // unconditionally every commit — even with a value React's own
  // `Object.is` bailout would otherwise have caught — measurably cost an
  // extra invocation of this whole component on top of a render already in
  // flight from a prop change (a second `todayKey` computation
  // history.test.tsx's own memoisation test counts), rather than being
  // free just because the state ends up unchanged.
  useLayoutEffect(() => {
    const next = spacerRef.current?.offsetTop ?? 0;
    if (next !== contentAboveList) {
      setContentAboveList(next);
    }
  });

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollElement,
    // Issue #147: a `dayReferrers` row starts at an estimate of `0`, not
    // `ESTIMATED_ROW_HEIGHT_PX` — deliberately, and this is what actually
    // keeps a day with nothing Referring to it showing NOTHING rather than
    // a blank gap the size of an ordinary row. Most days have no referrer
    // at all, so `0` is already the *correct* answer for the common case
    // before `DayReferrersRow`'s own probe ever resolves, which sidesteps
    // `measureElement` below entirely for that case: there is no "real
    // measured 0" to distrust when the estimate was already 0. Only once a
    // referrer is confirmed does this row grow — from a true `0` to a real,
    // positive `measureElement` reading — the same "estimate, then correct
    // once rendered" path every other row already takes, just starting
    // from the opposite end.
    estimateSize: (index) =>
      flatItems[index]?.kind === "dayReferrers" ? 0 : ESTIMATED_ROW_HEIGHT_PX,
    overscan: OVERSCAN,
    // Issue #79/#83: see FlatItem's own comment — measured sizes must
    // follow the row, not the index, across a prepend.
    getItemKey: (index) => flatItems[index]?.key ?? index,
    scrollMargin: contentAboveList,
    // jsdom never lays anything out, so the default `measureElement` — real
    // browser or not, it falls back to `element.offsetHeight` whenever
    // there's no ResizeObserver `entry` to read a real size from, which is
    // always, under jsdom — reports 0 for every row the instant its ref
    // attaches. Correcting the estimate down to a real 0 is exactly what
    // measurement is for in a real browser; in jsdom it is never real, and
    // "every row's size changed" is exactly the kind of change that forces
    // an extra render, which is what actually broke this: History re-runs
    // its own `todayKey` computation (deliberately unmemoised — see its own
    // comment above) on every render, so an extra virtualizer-driven render
    // on mount meant an extra `entryDayKey` call history.test.tsx's own
    // memoisation test counts exactly. Delegating to the library's own
    // `measureElement` first keeps every real code path (ResizeObserver
    // entries, `useCachedMeasurements`) exactly as it ships; the only thing
    // added is treating a *measured* zero as "not actually measured" and
    // keeping whatever size this row already had — the running estimate,
    // or an earlier genuine measurement — instead of "correcting" to it.
    measureElement: (element, entry, instance) => {
      const measured = measureElementDefault(element, entry, instance);
      if (measured > 0) {
        return measured;
      }
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
    },
  });
  // `getVirtualItems()` comes back *empty* — not overscan-padded, actually
  // empty — whenever the virtualizer's measured viewport size is exactly
  // zero: `calculateRange` (`@tanstack/virtual-core`) bails out to "no
  // range" before `overscan` ever gets a say, rather than treating a
  // zero-size viewport as a viewport with nothing visible plus overscan
  // around it. That's the real shape of both cases this ticket needs
  // handled: no `scrollElement` at all (history.test.tsx renders `<History>`
  // with no `<Shell>` around it) and a genuine `scrollElement` whose
  // `getBoundingClientRect()` jsdom always reports as all-zero (every other
  // suite).
  //
  // The fallback below is keyed on *that cause* — no scroll element, or one
  // that hasn't measured to a real, non-zero size yet — rather than on
  // `getVirtualItems()` itself coming back empty, which is only ever a
  // symptom of it: the same "measured viewport size is exactly zero" shape
  // a real browser is in for the handful of frames before its first
  // ResizeObserver callback lands, not something unique to jsdom. Reading
  // the cause directly, instead of that symptom, is what keeps this from
  // ever silently also catching some other, unrelated reason a real, sized
  // viewport's own range might come back empty.
  //
  // The fallback is built here rather than read off the virtualizer's own
  // `measurementsCache` — that field holds exactly this data in principle,
  // but reading it turned out to be order-sensitive against this repo's own
  // integration (this hook's `getItemKey` is a fresh closure every render,
  // which defeats `@tanstack/virtual-core`'s internal memoisation of it —
  // see `getItemKey`'s own comment above — and observed behaviour reading
  // `measurementsCache` shifted between renders in a way this comment isn't
  // going to promise an explanation for holding up). Every position below
  // uses the same flat `ESTIMATED_ROW_HEIGHT_PX` per row rather than
  // anything the virtualizer has actually measured — acceptable because
  // this path only exists to guarantee *something* real renders (this
  // ticket's own jsdom requirement, and a real window's very first paint
  // before its first ResizeObserver callback lands); the moment a genuine
  // viewport size is known, `getVirtualItems()` takes back over and
  // `measureElement` corrects every row to its real height. Sliced to
  // `MAX_FALLBACK_ROWS` (its own comment) rather than the whole of
  // `flatItems` — a real History's very first paint is exactly the case
  // this fallback must never let balloon into "render everything".
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;
  const hasSizedScrollElement = scrollElement !== null && viewportHeight > 0;
  const rangedVirtualRows = virtualizer.getVirtualItems();
  const virtualRows: VirtualItem[] = hasSizedScrollElement
    ? rangedVirtualRows
    : flatItems.slice(0, MAX_FALLBACK_ROWS).map((flatItem, index) => ({
        index,
        key: flatItem.key,
        start: index * ESTIMATED_ROW_HEIGHT_PX,
        end: (index + 1) * ESTIMATED_ROW_HEIGHT_PX,
        size: ESTIMATED_ROW_HEIGHT_PX,
        lane: 0,
      }));

  // Issue #83: hands the virtualizer's own `scrollToIndex` up to Shell so
  // `usePinnedScroll` (called there) can jump to the newest row through it
  // instead of the `scrollTop = scrollHeight` default that only ever
  // worked when every row was really in the DOM — see
  // HistoryScrollContext's own comment. Re-registers whenever the count
  // changes (an Entry arriving moves which index is "newest"); unregisters
  // on unmount so Shell can never call into a virtualizer that's gone.
  useEffect(() => {
    if (flatItems.length === 0) {
      registerScrollToNewest(null);
      return;
    }
    const newestIndex = flatItems.length - 1;
    registerScrollToNewest(() => {
      virtualizer.scrollToIndex(newestIndex, { align: "end" });
    });
    return () => registerScrollToNewest(null);
  }, [flatItems.length, registerScrollToNewest, virtualizer]);

  // Issue #143: which Entry, if any, a seek just landed on should still be
  // flashed — set by the seek effect below the instant it finds an "entry"
  // kind target, and cleared by its own timer a fixed duration later (the
  // effect just after this state). Kept separate from `seek`/`onSeekSettled`
  // deliberately: `onSeekSettled` fires (and clears `?e=`) the instant the
  // row is found, far sooner than a reader can register a flash, so tying
  // the flash's lifetime to the URL param would either cut it short or hold
  // the param open for a concern it has nothing to do with.
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(null);
  useEffect(() => {
    if (highlightedEntryId === null) {
      return;
    }
    const timer = setTimeout(() => setHighlightedEntryId(null), SEEK_HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [highlightedEntryId]);

  // A stable primitive to key the effect below on (its own comment) —
  // `seek` itself is a fresh object every render composer-page.tsx has one
  // active, regardless of which kind it names.
  const seekTargetKey = !seek
    ? null
    : seek.kind === "day"
      ? `d:${seek.dayKey}`
      : `e:${seek.entryId}`;

  // Issue #142/#143: "page until you arrive" — the seek's own convergence
  // step. `seek` names a day or an Entry; this finds the matching row in
  // `flatItems` (the one thing only History can do, since flattening and
  // the virtualizer both live here) and reacts to whichever of the three
  // outcomes actually holds this render:
  //
  // - found -> scroll to it and report the seek settled. `align: "start"`
  //   puts the target at the top of the viewport, the same place a day
  //   separator sits during ordinary scrolling, rather than centring an
  //   arbitrary row. An "entry" seek additionally starts its flash — see
  //   `highlightedEntryId`'s own comment above for why that state, and its
  //   clearing, live apart from the rest of this.
  // - not found, but `flatItems` might still grow (composer-page.tsx owns
  //   `pagination`, not this component — see onSeekNeedsOlder's own doc
  //   comment) -> ask for another older page.
  // - not found, and composer-page.tsx's own `onSeekNeedsOlder` handler has
  //   nothing further to fetch -> that handler calls `onSeekSettled`
  //   itself; History never decides "give up" on its own, only "not found
  //   yet," which is what keeps this effect from ever needing to loop.
  //
  // An effect, not a plain render-body call: `flatItems` only changes when
  // `entries` actually grows a page (it's memoised on `groups`, itself
  // memoised on `entries` — see those comments above), so gating on it
  // here is what stops this from re-running, and re-requesting a page, on
  // every unrelated render while a seek is in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `seekTargetKey`, not `seek` itself — composer-page.tsx hands this down as a fresh object on every render a seek is active, and depending on its identity would re-run this effect (and re-request an older page) on every unrelated re-render rather than only when the target, or the data available to search, actually changes.
  useEffect(() => {
    if (!seek) {
      return;
    }
    const targetIndex = flatItems.findIndex((item) =>
      seek.kind === "day"
        ? item.kind === "separator" && item.dayKey === seek.dayKey
        : item.kind === "entry" && item.entry.id === seek.entryId,
    );
    if (targetIndex === -1) {
      onSeekNeedsOlder?.();
      return;
    }
    virtualizer.scrollToIndex(targetIndex, { align: "start" });
    if (seek.kind === "entry") {
      setHighlightedEntryId(seek.entryId);
    }
    onSeekSettled?.();
  }, [seekTargetKey, flatItems, virtualizer, onSeekNeedsOlder, onSeekSettled]);

  // Issue #83's bottom alignment: however much shorter the virtualized
  // list is than the viewport, floored at zero — a leading spacer that
  // pushes a short History down against the Composer instead of the
  // `min-h-full justify-end` ADR 0018 used before rows were removed from
  // flow (`justify-end` has nothing to distribute against an absolutely
  // positioned child; see PinnedThreadConfig's own `ownsBottomAlignment`
  // comment in shell.tsx for the fuller reasoning and why Shell's own
  // treatment stands down for this page). `viewportHeight` (computed above,
  // alongside the fallback rows that key off this same reading of it) is
  // the same ResizeObserver-backed size the virtualizer measures the scroll
  // element with — reactive to the window resizing for free, and `{width:0,
  // height:0}` under jsdom (no ResizeObserver there), which is exactly
  // what floors this at zero in every unit test.
  const totalSize = virtualizer.getTotalSize();
  const spacerHeight = Math.max(0, viewportHeight - contentAboveList - totalSize);

  // Issue #83's always-present day pill: which day the topmost *visible*
  // row belongs to — `range` (not `getVirtualItems()[0]`, which includes
  // overscan rendered above what's actually on screen and would name the
  // day one scroll-frame too early). Falls back to the very first
  // flattened row once nothing has been measured yet (mount, or jsdom,
  // where `range` never moves off its initial guess).
  const topIndex = virtualizer.range?.startIndex ?? 0;
  const topmostItem = flatItems[topIndex] ?? flatItems[0];
  const topmostDayKey = topmostItem?.dayKey ?? null;
  // The topmost visible row is itself that day's own (flattened, inline)
  // separator exactly when the reader has scrolled to right where a day
  // begins — including the very first paint, where the oldest day's own
  // separator sits at the top of everything. Showing the always-present
  // pill *too*, right then, would put the same day's name on screen twice
  // — the inline separator already doing the job the pill exists for.
  // `position: sticky` can't decide this the way the old, one-pill-per-day
  // implementation did (see the pill's own comment below), so this is that
  // same "hand off once the current one scrolls out of the way" judgement,
  // made explicitly in JS instead.
  const showOverlayPill = topmostDayKey !== null && topmostItem?.kind !== "separator";

  if (entries.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        {query.trim() === "" ? "History will appear here." : "No matching Entries."}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {/* The always-present pill (issue #83), replacing the old per-group
          sticky separator below: `position: sticky` computes where to
          stick relative to the nearest ancestor with a scrolling
          mechanism, but an ancestor with `transform` set — exactly what
          every virtualized row below has, to place it — gives descendants
          a *new* containing block and breaks that calculation. A sticky
          separator nested inside one of those rows would stick relative
          to the row's own, constantly-repositioned box instead of the
          real scroll region. This element sits outside that subtree
          entirely (a sibling of the spacer and the virtualized list, not
          a descendant of either), so `sticky` here sticks the ordinary
          way, exactly like the old per-group pill did.

          Always mounted, never conditionally on `showOverlayPill`: sticky
          still OCCUPIES FLOW (it isn't `fixed`), so mounting/unmounting
          this wrapper on every flip changed the height of everything
          above the spacer below, which reads that height via
          `spacerRef.current.offsetTop`. Past the point History is longer
          than the viewport, `spacerHeight` is floored at zero (its own
          comment) and stops absorbing that change, so every row jumped by
          about the pill's height each time a day separator scrolled to
          the top — exactly when `showOverlayPill` flips. Toggling the
          inner `<span>`'s visibility instead — `invisible`
          (`visibility: hidden`), never `display: none`, which would pull
          it out of flow the same way unmounting the wrapper did — keeps
          this wrapper's own box (padding, border, the line height its
          font size implies) constant either way, so
          `spacerRef.current.offsetTop` never moves.

          The label text itself is still withheld while hidden, not just
          visually suppressed: whenever this pill is visible at all, its
          day is also the one currently at the top of the flattened list
          below — either still on screen (a real scroll position) or, at
          mount and under jsdom, the fallback's own first row (`topIndex`
          never moves off 0 there — see `topmostItem`'s own comment). An
          `invisible` span carrying the same label text as that inline
          separator would leave two DOM nodes with identical text — CSS
          hides one from sight, but nothing hides it from
          `getByText`/assistive tech, which is exactly what broke this
          being unique. Rendering nothing inside instead keeps the box
          (and so the height) without duplicating the text. */}
      {/* `h-9` is load-bearing, not styling. This wrapper sits in flow
          above the spacer `contentAboveList` is measured from, so any
          change to its height shifts every absolutely-positioned row
          below — and on a History longer than the viewport `spacerHeight`
          is floored at 0, so nothing absorbs it. Keeping the element
          mounted was not enough on its own: withholding the label text
          (see above) leaves an empty inline span, which collapses to a
          different height than one containing text, and that was still
          worth 16px of jump per toggle, measured in a real browser. A
          fixed height makes the flow contribution independent of the
          contents entirely. */}
      <div
        data-testid="day-pill-wrapper"
        className="sticky top-0 z-10 flex h-9 items-center justify-center"
      >
        {/* Issue #146: a `<button>`, not a `<span>` — tapping this opens
            `DatePickerSheet` seeded with the topmost visible day, the same
            as the inline separator below. `h-9` on the wrapper above is
            what actually guarantees ADR 0030's "must not change height":
            an explicit CSS height on a block-level box is not derived from
            its children, so nothing this element does can grow or shrink
            it. `appearance-none` is the one thing still worth adding on
            top of that guarantee, rather than relying on it alone: this
            app's global stylesheet (`index.css`'s `@import "tailwindcss"`)
            already resets margin/padding/border to zero on every element
            via Tailwind's own preflight (`*, ::before, ::after { margin:
            0; padding: 0; border: 0 solid }`), so a bare `<button>` starts
            from the identical box the old `<span>` did before either
            one's own utility classes (`px-3 py-0.5 border`, both below)
            apply — but that same preflight deliberately leaves
            `appearance: button` on button elements (so a plain, unstyled
            button still looks like a native one by default), and that
            native rendering is the one remaining way a browser could paint
            this wider or taller than the specified box. `appearance-none`
            turns that off, so what's below is the only thing drawing this
            control in every browser, not a browser's own button chrome
            layered underneath it. */}
        <button
          type="button"
          // Gated on `topmostDayKey !== null` alone, not `showOverlayPill`
          // too: `showOverlayPill` only decides whether this pill's own
          // label is currently the one thing on screen naming this day (as
          // opposed to the inline separator already doing that job right
          // above it — see that flag's own comment). Either way the
          // topmost day is a real one worth seeding the picker with; the
          // `invisible` class below (`visibility: hidden`) already removes
          // this control from hit-testing, focus order and the
          // accessibility tree for a real pointer or keyboard user whenever
          // it applies, so nothing here needs to re-decide that in JS.
          onClick={() => {
            if (topmostDayKey !== null) {
              setDatePickerDayKey(topmostDayKey);
            }
          }}
          title={
            showOverlayPill && topmostDayKey !== null
              ? formatDaySeparatorTitle(topmostDayKey)
              : undefined
          }
          aria-label={
            showOverlayPill && topmostDayKey !== null
              ? `Choose a date to jump to — currently showing ${
                  formatDaySeparatorTitle(topmostDayKey) ??
                  formatDaySeparator(topmostDayKey, todayKey)
                }`
              : "Choose a date to jump to"
          }
          className={cn(
            "appearance-none rounded-full border border-border bg-muted/90 px-3 py-0.5 text-xs font-medium text-muted-foreground backdrop-blur-sm",
            !showOverlayPill && "invisible",
          )}
        >
          {showOverlayPill && topmostDayKey !== null
            ? formatDaySeparator(topmostDayKey, todayKey)
            : null}
        </button>
      </div>
      {/* The bottom-alignment spacer (issue #83) — see its height's own
          comment above. Also this component's own non-circular measuring
          point for `contentAboveList`, via `spacerRef`; it renders even at
          zero height so that measurement always has something to attach
          to. */}
      <div ref={spacerRef} style={{ height: spacerHeight }} aria-hidden="true" />
      <div ref={rowsRef} style={{ position: "relative", height: totalSize, width: "100%" }}>
        {virtualRows.map((virtualRow) => {
          const item = flatItems[virtualRow.index];
          if (!item) {
            return null;
          }
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              // `top: 0` plus `transform: translateY` — not a plain `top`
              // offset — is `@tanstack/react-virtual`'s own documented
              // positioning shape (its `scrollMargin` accounting already
              // assumes it), and it's a GPU-composited move rather than a
              // layout-triggering one, which matters once there are enough
              // rows scrolling past for the difference to be visible.
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start - contentAboveList}px)`,
              }}
            >
              {item.kind === "separator" ? (
                // The inline, in-flow separator (ticket 52) — no longer
                // itself `sticky` (see the always-present pill's own
                // comment above for why that stopped working once rows
                // moved out of flow); it still renders right where its
                // day's Entries begin, exactly as before.
                <div className="flex justify-center py-2">
                  {/* Issue #146: same button, same height-neutrality
                      reasoning as the always-present pill above — see its
                      own comment. This one sits inside a virtualized row
                      instead of the fixed-height wrapper, so here it's the
                      row's own `measureElement` (not a fixed CSS height)
                      that would notice any growth; `appearance-none` still
                      applies for the same reason, so this row measures the
                      same whether the reader has scrolled past it or not. */}
                  <button
                    type="button"
                    // Same accessible name as the sticky pill above (both
                    // markers do the same thing), which leaves nothing to
                    // tell them apart by role/name alone once the pill is
                    // also showing this same day — real, not hypothetical:
                    // a short thread's pinned-to-newest scroll position can
                    // already be past its one day separator on first paint.
                    // `data-testid` disambiguates for the e2e suite only;
                    // nothing in this app queries it.
                    data-testid="day-separator"
                    onClick={() => setDatePickerDayKey(item.dayKey)}
                    title={formatDaySeparatorTitle(item.dayKey)}
                    aria-label={`Choose a date to jump to — currently showing ${
                      formatDaySeparatorTitle(item.dayKey) ??
                      formatDaySeparator(item.dayKey, todayKey)
                    }`}
                    className="appearance-none rounded-full border border-border bg-muted/90 px-3 py-0.5 text-xs font-medium text-muted-foreground backdrop-blur-sm"
                  >
                    {formatDaySeparator(item.dayKey, todayKey)}
                  </button>
                </div>
              ) : item.kind === "dayReferrers" ? (
                // Issue #147: see `DayReferrersRow`'s own comment for why
                // this is a row of its own rather than something folded
                // into the separator above.
                <DayReferrersRow dayKey={item.dayKey} probe={dayReferrers} />
              ) : (
                // A bubble, not a row (ADR 0036). The `border-t` that used
                // to travel with each row is gone with it: bubbles are told
                // apart by their own shape and the gap between them, and a
                // rule between two of them would be drawing a boundary the
                // fill already draws. `isFirstInGroup` still earns its keep
                // — it is exactly "the first Entry under a day separator",
                // which is the one bubble in a run that must NOT be grouped
                // tightly against what sits above it.
                //
                // Every Entry is `side="out"`: Composer is all-outgoing
                // because an Entry has no addressee (CONTEXT.md), not
                // because the other side happens to be empty.
                <EntryBubble
                  entry={item.entry}
                  query={query}
                  syncEnabled={syncEnabled}
                  side="out"
                  groupedWithPrevious={!item.isFirstInGroup}
                  actions={actions}
                  highlighted={item.entry.id === highlightedEntryId}
                />
              )}
            </div>
          );
        })}
      </div>
      {actions && (
        // The one EntryActionsSheet instance for however many rows are
        // above (issue #78) — rendered here, once, rather than inside the
        // `.map` that builds each EntryRow. Only mounted when `actions` is
        // present at all: with no Edit/Delete wired up, nothing can ever
        // set `sheetEntry`, so there is nothing for a sheet to show.
        <EntryActionsSheet
          entry={sheetEntry}
          onOpenChange={(open) => {
            if (!open) {
              setSheetEntry(null);
            }
          }}
          onEdit={actions.onEdit}
          onCopy={copyEntry}
          onRefer={actions.onRefer}
          onDelete={actions.onDelete}
        />
      )}
      {onDelete && (
        // The one confirm dialog for however many rows are above (issue
        // #82). Guarded on the real `onDelete` rather than on `actions`,
        // because `actions` already hands rows a *requester* — this is the
        // only place the actual delete is reachable from.
        <ConfirmDialog
          open={confirmEntry !== null}
          onOpenChange={(open) => {
            // Escape, an outside click and Cancel all arrive here with
            // `open === false`, and none of them may delete anything.
            if (!open) {
              setConfirmEntry(null);
            }
          }}
          title="Delete this Entry?"
          description="This can't be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            if (confirmEntry) {
              onDelete(confirmEntry);
            }
            setConfirmEntry(null);
          }}
        />
      )}
      {/* Issue #146: the one DatePickerSheet instance for however many day
          markers this thread renders (the sticky pill plus one inline
          separator per day) — same "one sheet above every row" shape as
          EntryActionsSheet/ConfirmDialog above. Every date stays selectable
          (date-picker-sheet.tsx's own doc comment); `handleDateConfirm`
          navigates exactly where `DateReferenceLink` (entry-row.tsx) does,
          so a tapped day and a followed Reference converge on the same
          seek in composer-page.tsx rather than a second path. */}
      <DatePickerSheet
        open={datePickerDayKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDatePickerDayKey(null);
          }
        }}
        initialDate={datePickerDayKey ?? undefined}
        onConfirm={handleDateConfirm}
      />
    </div>
  );
}
