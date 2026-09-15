import type {
  CommentStore,
  EntryStore,
  EventStore,
  FilterStore,
  LabelStore,
  ProjectStore,
  TaskStore,
} from "@meologue/core";
import { today } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { type Destination, useDestinations } from "@/components/chat-list";
import { ChatListPane } from "@/components/chat-list-pane";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useHistory } from "@/hooks/use-history";
import { useTasks } from "@/hooks/use-tasks";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { formatDigestRange } from "@/lib/digest-format";
import { type DigestResult, digestTransport } from "@/lib/digest-transport";
import { deviceUtcOffsetMinutes, entryDayKey } from "@/lib/entry-day";
import { readLastDestination } from "@/lib/last-destination";
import { localDayKey } from "@/lib/local-day-key";
import { digestQueryKey } from "@/lib/query-keys";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";

/**
 * What `/` renders, which depends on how wide the window is.
 *
 * On a narrow window the list is the whole screen, so this is the list.
 *
 * At the wide breakpoint `chat-shell-layout.tsx` already has the list pinned
 * to the left, so rendering it again here would show it twice. What `/`
 * means there instead used to be an explicit "nothing chosen yet" placeholder
 * — the state ADR 0018 flagged as unreachable for a single-thread app, and
 * which four (then five) real destinations made representable again.
 *
 * ADR 0080 amends that: the placeholder was a dead end for a reader whose
 * only way back from any Destination is a hard `Link to="/"`
 * (`back-to-chats.tsx`) — landing on a sentence telling them to pick
 * something from a list they can already see beside it added nothing. `/`
 * now gets content of its own instead: a Continue card back into whichever
 * Destination the reader was last in, and a Today summary. It is still not
 * a sixth Destination — it has no row of its own on the root screen, it
 * does not exist below 900px, and the pane beside it is unchanged.
 */
export function ChatListPage() {
  const wide = useWideLayout();

  if (!wide) {
    return <ChatListPane />;
  }

  return <ChatListColumn />;
}

/**
 * The wide-breakpoint content column, split out from `ChatListPage` so its
 * hooks (`useDestinations`, the entry-store read below) never run on a
 * narrow window, where none of this renders at all.
 */
function ChatListColumn() {
  const destinations = useDestinations();
  const lastDestinationTo = readLastDestination();
  // Looked up against the *live* `useDestinations()` result, not trusted
  // straight off `last-destination.ts` — this is what keeps a since-hidden
  // Destination from ever being offered back: `find` simply returns
  // `undefined` for a `to` no longer in the (already hidden-filtered) array.
  const continueDestination = destinations.find(
    (destination) => destination.to === lastDestinationTo,
  );

  const composerDestination = destinations.find((destination) => destination.to === "/composer");
  const todoDestination = destinations.find((destination) => destination.to === "/todo");
  const digestDestination = destinations.find((destination) => destination.to === "/digest");
  const hasSummary =
    composerDestination !== undefined ||
    todoDestination !== undefined ||
    digestDestination !== undefined;

  if (continueDestination === undefined && !hasSummary) {
    // Every hideable Destination is hidden, and nothing has been continued
    // into yet — a real, reachable state (issue #134 lets a reader hide all
    // four), and it has to read as deliberate rather than as a blank void.
    // The pane beside this column still has Settings, which is how a reader
    // gets back here.
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-8">
        <p className="text-center text-muted-foreground text-sm">
          Nothing to continue yet — pick a Destination from the list.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
      {continueDestination !== undefined && <ContinueCard destination={continueDestination} />}
      {hasSummary && (
        <section className="flex flex-col gap-1">
          <h2 className="px-3 font-medium text-foreground text-sm">Today</h2>
          <div className="flex flex-col">
            {(composerDestination !== undefined || todoDestination !== undefined) && (
              <EntryAndTaskToday
                showEntries={composerDestination !== undefined}
                showTasks={todoDestination !== undefined}
              />
            )}
            {digestDestination !== undefined && <DigestLine locked={digestDestination.locked} />}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The Destination the reader was last in (ADR 0080), as a link straight back
 * into it — a thing to click, so `/` never traps a reader and Back stays
 * deterministic (`back-to-chats.tsx`'s own "a real `<Link>`, not
 * `history.back()`" reasoning applies here for the identical reason).
 *
 * The link is the Destination's bare path, and carries no position within
 * that Destination. It once pointed at a companion feature that restored
 * the day the Composer had been scrolled to; that feature was removed
 * after it proved unreliable against the virtualized list in a real
 * browser — landing on a fixed wrong day rather than the one being read —
 * so a Destination now simply opens the way it always does. Should
 * anything like it return, the position belongs to the Destination's own
 * restore-on-mount rather than encoded here: a copy in this link would go
 * stale the moment that memory moved on, and would only help readers who
 * arrived by this card rather than by the pane or a typed URL.
 */
function ContinueCard({ destination }: { destination: Destination }) {
  const { to, label, Icon, summary } = destination;

  return (
    <Link
      to={to}
      className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="transition-colors hover:bg-muted/60">
        <CardHeader>
          <CardDescription>Continue</CardDescription>
          <CardTitle className="flex items-center gap-2">
            <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
            {label}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{summary}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

/** One clickable stat row of the Today summary — every line below shares this shape. */
function SummaryLine({ to, label, value }: { to: string; label: string; value: string }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="font-medium text-foreground text-sm">{value}</span>
    </Link>
  );
}

/**
 * "Entries written today" and "Tasks due today" — both need the Entry
 * store, which `/` renders outside of (`App.tsx`'s own comment on why). This
 * opens (or, in the ordinary case, simply reuses — `main.tsx`'s `SyncLoop`
 * already holds it open, `use-sync-loop.ts`'s own doc comment) the same
 * `entryStoreQueryOptions` query `EntryStoreLayout` and `SyncLoop` share,
 * rather than reading anything that only exists inside `EntryStoreLayout`'s
 * own Outlet — this component is not nested under it and cannot reach
 * `useEntryStore()`.
 */
function EntryAndTaskToday({
  showEntries,
  showTasks,
}: {
  showEntries: boolean;
  showTasks: boolean;
}) {
  const { data, isError } = useQuery(entryStoreQueryOptions);

  if (data === undefined) {
    // Two different states, told apart rather than collapsed. A store that
    // is still opening resolves within a frame or two — `SyncLoop` starts
    // the same open on the app's very first paint, well before a reader
    // reaches this column — so "nothing yet" is the honest reading of a
    // count not known yet.
    //
    // A store that has FAILED to open is not that. `entryStoreQueryOptions`
    // sets `retry: false` precisely because `StorageUnavailableError` and
    // `SecondTabError` are permanent, not transient (entry-store-layout.tsx),
    // so an errored query keeps `data === undefined` forever. Reporting
    // "Nothing yet" there would tell a reader they wrote nothing today when
    // the truth is that the app cannot read what they wrote — the same
    // distinction `digestLineValue` below already refuses to collapse.
    const value = isError ? "Unavailable" : undefined;
    return (
      <>
        {showEntries && (
          <SummaryLine
            to="/composer"
            label="Entries written today"
            value={value ?? "Nothing yet"}
          />
        )}
        {showTasks && (
          <SummaryLine to="/todo/today" label="Tasks due today" value={value ?? "Nothing due"} />
        )}
      </>
    );
  }

  return <EntryAndTaskTodayReady data={data} showEntries={showEntries} showTasks={showTasks} />;
}

/** The opened-store bag `entryStoreQueryOptions` resolves to — mirrors `entry-store-layout.tsx`'s own inline type for the identical shape, since that file exports the query options but not a name for what they resolve to. */
interface OpenedEntryStores {
  store: EntryStore;
  taskStore: TaskStore;
  labelStore: LabelStore;
  projectStore: ProjectStore;
  commentStore: CommentStore;
  eventStore: EventStore;
  filterStore: FilterStore;
  deviceId: string;
}

/**
 * Split out from `EntryAndTaskToday` so `useHistory`/`useTasks` — which both
 * need real store instances, not `undefined` — are only ever called once
 * the store has actually opened, by mounting an entirely different
 * component rather than branching inside one that already called them.
 */
function EntryAndTaskTodayReady({
  data,
  showEntries,
  showTasks,
}: {
  data: OpenedEntryStores;
  showEntries: boolean;
  showTasks: boolean;
}) {
  // Entries written today — the existing infinite query in use-history.ts
  // (50 newest at a time, ADR 0030), compared against localDayKey(new
  // Date()) below. A reader who wrote more than the newest 50 Entries
  // today would undercount — accepted rather than widened: the same page
  // every other reader of `entries` already lives with.
  const { entries } = useHistory(
    data.store,
    data.taskStore,
    data.projectStore,
    data.labelStore,
    data.commentStore,
    data.eventStore,
    data.deviceId,
  );
  // Tasks due today — today() from @meologue/core, exactly as
  // today-view.tsx already calls it, over useTasks's own `tasks`.
  const { tasks } = useTasks(
    data.store,
    data.taskStore,
    data.projectStore,
    data.labelStore,
    data.commentStore,
    data.eventStore,
    data.deviceId,
  );

  const todayKey = localDayKey(new Date());
  const offset = deviceUtcOffsetMinutes();
  const entriesToday = entries.filter(
    (entry) => entryDayKey(entry.createdAt, offset) === todayKey,
  ).length;
  const { dueToday } = today(tasks, todayKey);

  return (
    <>
      {showEntries && (
        <SummaryLine
          to="/composer"
          label="Entries written today"
          value={entriesToday === 0 ? "Nothing yet" : String(entriesToday)}
        />
      )}
      {showTasks && (
        <SummaryLine
          to="/todo/today"
          label="Tasks due today"
          value={dueToday.length === 0 ? "Nothing due" : String(dueToday.length)}
        />
      )}
    </>
  );
}

/**
 * "Most recent Digest" — `digestTransport("day")` under `digestQueryKey("day")`,
 * the same key `digest-page.tsx` fetches under, so the two share one cache
 * entry rather than this summary running a second, independent request.
 */
function DigestLine({ locked }: { locked: boolean }) {
  const digestQuery = useQuery({
    queryKey: digestQueryKey("day"),
    queryFn: () => digestTransport("day"),
    // Locked already means "Sync is off, or this Server lacks the Digest
    // model" (chat-list.tsx's own useDestinations) — fetching anyway would
    // be a request this summary already knows the answer to.
    enabled: !locked,
  });

  return (
    <SummaryLine
      to="/digest"
      label="Most recent Digest"
      value={digestLineValue(locked, digestQuery.data)}
    />
  );
}

/**
 * Locked stays a single, neutral word — the same restraint `chat-list.tsx`'s
 * own locked row shows (it "carries no new prose of its own"; opening the
 * Destination is what explains the gap). Unreachable and not-supported are
 * spelled out, because `digestTransport` distinguishes them for a reason
 * (this file's own header comment on the Digest empty states): an outage is
 * not the same fact as an old Server, and Sync being off is a third,
 * different fact `locked` already covers above them both.
 */
function digestLineValue(locked: boolean, result: DigestResult | undefined): string {
  if (locked) {
    return "Locked";
  }
  if (result === undefined) {
    return "Nothing yet";
  }
  if (!result.ok) {
    return result.reason === "not-supported"
      ? "Not supported by this Server"
      : "Server unreachable";
  }
  if (result.digest === null) {
    return "Nothing yet";
  }
  return formatDigestRange("day", result.digest.period_start, result.digest.period_end);
}
