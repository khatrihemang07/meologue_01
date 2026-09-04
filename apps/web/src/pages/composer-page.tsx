import type { Entry, Task } from "@meologue/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { Composer, type ComposerHandle } from "@/components/composer";
import { History, type HistorySeekTarget } from "@/components/history";
import { Shell } from "@/components/shell";
import { TaskDetailView } from "@/components/todo/task-detail-view";
import { TaskScheduleSheet } from "@/components/todo/task-schedule-sheet";
import { useHistorySearch } from "@/hooks/use-history-search";
import { commentsForTask } from "@/lib/comment-counts";
import type { ComposerPromotionContext } from "@/lib/promote-tasks";
import { useSyncEnabled } from "@/lib/settings";
import { toggleTaskAt } from "@/lib/toggle-task";
import { useEntryStore } from "@/pages/entry-store-layout";

// A date Reference's own destination (issue #142): `?d=YYYY-MM-DD`, a query
// param rather than a path segment. `/composer` has no child routes, and
// chat-list.tsx's own NavLink matches it with `end: true` (that file's own
// comment on why) — a segment (`/composer/2026-08-28`) would fail that
// match entirely, costing the chat list's `aria-current`, where a query
// param leaves both untouched. It also composes for free with everything
// else that already reaches this route by URL: Back, a reload, and a link
// from a different Destination (the Digest reader, Reflection's Grounding)
// all just need this one string.
const SEEK_DAY_PARAM = "d";
const DAY_KEY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// An Entry Reference's own destination (issue #143), extending the exact
// same mechanism above it: `?e=<uuid>`, a query param for the reasons
// `SEEK_DAY_PARAM`'s own comment already gives — none of them are specific
// to a day. Shape-only, like DAY_KEY_SHAPE just above rather than
// inline-markdown.ts's own `ENTRY_SHAPE`: that regex additionally requires
// the `e:` mark prefix, which doesn't apply to a bare id sitting in the URL.
const SEEK_ENTRY_PARAM = "e";
const ENTRY_ID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// The Task detail overlay's own address (issue #181, criterion 4: "opens
// the Task over the Composer, without leaving the Composer"). `?task=<id>`
// joins `?d=`/`?e=` above as a third query param this same route answers,
// rather than `/todo/task/<slug>-<id>` (task-detail-route.ts) — navigating
// there would leave the Composer entirely (a different route, a different
// `<Shell>` title, a different History instance), losing exactly the
// in-progress draft and scroll position criterion 4 asks to keep. Reusing
// `ENTRY_ID_SHAPE` rather than a second, identical regex: a Task's id and
// an Entry's id are both `mintId()`'s own uuidv7 shape (id.ts), so the
// pattern is the same regardless of which root noun it names.
//
// Opening pushes a real history entry (`setSearchParams`'s own default —
// see `openTaskOverlay` below), so the phone/browser Back button dismisses
// the overlay and lands back on this same Composer with nothing else
// disturbed, rather than leaving it — the "strongly preferred" half of
// criterion 4's own design room. Closing explicitly (the overlay's own X,
// or Escape) instead *replaces* the current entry (`closeTaskOverlay`
// below) — the identical "this param's own job is already done, don't
// leave a dead entry for Back to skip past" reasoning `settleSeek` already
// applies to `?d=`/`?e=` once a seek resolves.
const TASK_PARAM = "task";

// `/` — the Composer plus the same, uncapped History that had its own
// route at `/history` before issue #75 deleted it (a second door onto the
// identical component with the identical props, once judged redundant).
// Uncapped on the theory that a future ticket might cap what shows here
// without touching the shared History component itself.
export function ComposerPage() {
  const {
    entries,
    pagination,
    sendEntry,
    search,
    editEntry,
    commitEntryEdit,
    removeEntry,
    disabled,
    message,
    dayReferrers,
    // Issue #174: the day block's own source — the exact active-Task
    // array Today and Inbox already render from, handed to History so it
    // can filter it per day with `tasksForDay` (task-views.ts).
    tasks,
    // Issue #181: the rest of Todo's own machinery, handed straight
    // through to History's day block and to the Task detail overlay below
    // — the identical fields todo-page.tsx already reads off this same
    // context, none of it re-derived here a second time.
    completedTasks,
    projects,
    labels,
    comments,
    events,
    completeTask,
    uncompleteTask,
    advanceRecurringTask,
    renameTask,
    setTaskDate,
    setTaskDeadline,
    setTaskPriority,
    setTaskProject,
    setTaskLabels,
    setTaskDescription,
    addComment,
    editComment,
    removeComment,
  } = useEntryStore();
  // Subscribed, not a one-off read: a change saved on Settings now updates
  // this without a reload or a remount (ticket 36), on top of the render
  // this component already gets when it remounts navigating back from
  // Settings (ADR 0008 — Settings is a sibling route, not a child).
  const syncEnabled = useSyncEnabled();

  // Ticket 55: the magnifier now expands this page's app bar into a search
  // field too, narrowing the same thread History does — see
  // use-history-search.ts for the URL param, sessionStorage backup, and the
  // oldest-to-newest reversal: `shown` is `entries`, narrowed or not, in
  // the store's own newest-first order; ADR 0014 guarantees a search
  // result arrives in that same order, so reversing after narrowing never
  // flips reading order either way.
  const { query, setQuery, shown, orderedEntries } = useHistorySearch(entries, search);

  // Bumped on every Send, independent of `entries` itself changing (that
  // update lands async, once the store's write settles): the pinned
  // thread (Shell's `pinnedThread`) treats a bump here as "jump to the
  // newest end unconditionally," ticket 53's rule for Send specifically,
  // as opposed to an Entry merely appearing (which only follows if the
  // reader was already pinned — see use-pinned-scroll.ts).
  //
  // Seeded `undefined`, not `0` (issue #81): `usePinnedScroll`'s own
  // `forceToNewest` guard is `if (forceToNewest === undefined) return`,
  // specifically so a mount — where nothing has been Sent yet — does
  // nothing. Seeding this at `0` defeated that guard (`0 !== undefined`),
  // so every mount of this page ran a *second* unconditional
  // `scrollToNewest` back to back with the `watch` effect's own one,
  // forcing the full-list layout read `scrollToNewest` does
  // (`el.scrollHeight`) twice for no reason. The type stays `number |
  // undefined` rather than switching to a boolean or a Date, because all
  // that ever mattered here is "has this changed since last render" —
  // `usePinnedScroll` only compares identity, never reads the value.
  const [sendSignal, setSendSignal] = useState<number | undefined>(undefined);

  function handleSend(body: string, promotion: ComposerPromotionContext) {
    sendEntry(body, promotion);
    // `?? 0` covers the first Send specifically: `undefined + 1` is `NaN`,
    // and — because `Object.is(NaN, NaN)` is `true` — a *second* Send would
    // then leave `forceToNewest` looking unchanged to the effect's
    // dependency check (`NaN` to `NaN`) and silently stop forcing the jump
    // from then on.
    setSendSignal((count) => (count ?? 0) + 1);
  }

  // Issue #142/#143: the seek a Reference lands here with, held entirely in
  // the URL rather than component state — the same reason Search's own
  // query lives in `?q=` (use-history-search.ts). `seek` is derived fresh
  // each render, not cached in a `useState`, because the URL param is
  // already the single source of truth: caching it separately would just
  // be a second place for the two to disagree.
  //
  // A malformed `?d=` or `?e=` (hand-edited, or a stale link to a shape this
  // app no longer uses) is treated as no seek at all rather than an error —
  // consistent with a Reference's own "malformed is not a Reference" rule
  // (inline-markdown.ts's `parseReferenceDate`/`ENTRY_SHAPE`), just applied
  // to the URL instead of an Entry's body.
  //
  // `?e=` wins deterministically when both are somehow present at once (a
  // hand-built URL, or a stale link built before this ticket only ever set
  // one) — checked first, so an Entry Reference's own, more specific target
  // is what a seek converges on rather than either param being silently
  // dropped or the two racing each other over the same virtualizer.
  const [searchParams, setSearchParams] = useSearchParams();
  const seekEntryParam = searchParams.get(SEEK_ENTRY_PARAM);
  const seekDayParam = searchParams.get(SEEK_DAY_PARAM);
  const seek: HistorySeekTarget | null =
    seekEntryParam !== null && ENTRY_ID_SHAPE.test(seekEntryParam)
      ? { kind: "entry", entryId: seekEntryParam }
      : seekDayParam !== null && DAY_KEY_SHAPE.test(seekDayParam)
        ? { kind: "day", dayKey: seekDayParam }
        : null;

  // Removes `?d=` and `?e=` once the seek has nowhere left to go — either
  // History found the target and scrolled to it, or (handleSeekNeedsOlder,
  // below) ran out of older Entries to check. Both are cleared regardless
  // of which one was actually driving the seek: clearing only the winner
  // (above) would leave a loser param sitting in the URL forever if both
  // happened to be present. `replace`, not the default push: this param's
  // own job is already done by the time it's cleared, so leaving it out of
  // history means Back from here returns to wherever the reader followed
  // the Reference from, rather than landing back on this exact mid-seek URL
  // and re-triggering the same seek a second time.
  const settleSeek = useCallback(() => {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.delete(SEEK_DAY_PARAM);
        params.delete(SEEK_ENTRY_PARAM);
        return params;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // History's own "not found yet" report (history.tsx's own comment on
  // `onSeekNeedsOlder` for why the hasMore/fetching decision lives here
  // rather than there: `pagination` is this page's, not History's own,
  // prop). Guarded the same way `usePinnedScroll.ts`'s own
  // `maybeFetchOlderPage` already guards issue #79's paging — `hasMore`
  // false ends the seek at the boundary instead of asking again forever,
  // and `fetching` true leaves an already-in-flight page alone rather than
  // racing a second `fetchNextPage` against it (TanStack Query's own infinite
  // query has no such guard built in).
  const handleSeekNeedsOlder = useCallback(() => {
    if (!pagination.hasMore) {
      settleSeek();
      return;
    }
    if (pagination.fetching) {
      return;
    }
    pagination.fetchMore();
  }, [pagination, settleSeek]);

  // ADR 0028: which Entry (if any) the Composer is editing, rather than
  // composing a new one. Owned here, not by Composer itself — see
  // composer.tsx's own `editingEntry` doc comment for why.
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);

  // `commitEntryEdit`, not `editEntry` (issue #173) — a genuine Composer
  // edit-commit is where Promotion also has to fire (ADR 0048: a bare
  // checkbox the reader just added while editing becomes a Task too, not
  // only one Sent fresh), unlike `handleToggleTask` below, which stays on
  // plain `editEntry` on purpose — see that function's own comment for why
  // a tick must never risk minting a Task mid-click.
  function handleCommitEdit(id: string, body: string, promotion: ComposerPromotionContext) {
    commitEntryEdit(id, body, promotion);
    setEditingEntry(null);
  }

  function handleCancelEdit() {
    setEditingEntry(null);
  }

  // Issue #153: a tapped checkbox. Splices only the marker characters
  // (`toggleTaskAt`, toggle-task.ts) and commits through plain `editEntry`
  // — ADR 0043's "a tick is an ordinary Entry edit," not a second write
  // path — deliberately NOT `commitEntryEdit` (issue #173): that door also
  // runs Promotion, and a tap on an EXISTING checkbox must never risk
  // minting a Task mid-click the reader never asked to create (a bare
  // checkbox with no Task behind it "keeps working exactly as it does
  // today," this ticket's own brief). Reads `entry.body` fresh off the
  // tap's own `entry` argument rather than looking it up in `entries`, so
  // this is correct even if `entries` has moved on since the checkbox was
  // rendered.
  function handleToggleTask(entry: Entry, markerFrom: number, markerTo: number) {
    editEntry(entry.id, toggleTaskAt(entry.body, markerFrom, markerTo));
  }

  // Issue #181: the Task detail overlay's own target — see `TASK_PARAM`'s
  // own comment above for why this rides in the URL rather than plain
  // component state. `tasks` first, `completedTasks` second, the identical
  // two-list lookup order `todo-page.tsx`'s own `openTask` already uses
  // (far more common case first; a Task is never in both).
  const openTaskIdParam = searchParams.get(TASK_PARAM);
  const openTaskId =
    openTaskIdParam !== null && ENTRY_ID_SHAPE.test(openTaskIdParam) ? openTaskIdParam : null;
  const openTask =
    openTaskId !== null
      ? (tasks.find((t) => t.id === openTaskId) ??
        completedTasks.find((t) => t.id === openTaskId) ??
        null)
      : null;
  const openTaskProject =
    openTask === null ? null : (projects.find((p) => p.id === openTask.projectId) ?? null);

  function openTaskOverlay(taskId: string) {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      params.set(TASK_PARAM, taskId);
      return params;
    });
  }

  function closeTaskOverlay() {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.delete(TASK_PARAM);
        return params;
      },
      { replace: true },
    );
  }

  // The one TaskScheduleSheet instance the overlay needs (mirroring
  // todo-page.tsx's own single shared instance) — no id of its own to
  // track, unlike that page's `schedulingId`: the Composer's overlay only
  // ever shows one Task at a time (`openTask`), so "which Task is being
  // scheduled" is never a separate question from "which Task is open."
  const [schedulingOpen, setSchedulingOpen] = useState(false);

  // Completes a Task from outside Todo's own row (the Day block, or the
  // overlay's own checkbox) — the identical `dateString` branch
  // todo-page.tsx's `handleComplete` already makes, reused rather than
  // reimplemented so a recurring Task advances instead of entering
  // `completedTasks` regardless of which surface ticked it. Undo is
  // offered for the same reason it is there: completing is always
  // reversible except where a series just ended, which this function is
  // never asked to do (that stays `completeForeverTask`, Todo's own
  // Shift+Click — this ticket adds no such gesture outside Todo).
  function handleCompleteTask(task: Task) {
    if (task.dateString !== null) {
      advanceRecurringTask(task.id);
      return;
    }
    completeTask(task.id);
    toast(`Completed "${task.content}"`, {
      action: { label: "Undo", onClick: () => uncompleteTask(task.id) },
    });
  }

  // Issue #144's "Refer" action (entry-actions.tsx, reached through
  // History's sheet or hover row) needs to reach into whichever Composer
  // is live on screen — see ComposerHandle's own comment (composer.tsx)
  // for why that has to be an imperative ref rather than a prop this page
  // could just pass down. Composer itself already targets the right
  // textarea whether or not `editingEntry` is set, so this page only has
  // to forward the call.
  const composerRef = useRef<ComposerHandle>(null);

  function handleRefer(entry: Entry) {
    composerRef.current?.insertAtCursor(`[[e:${entry.id}]]`);
  }

  // Reads an `editEntryId` a caller with no Composer of its own to edit in
  // navigates here with, in router state, rather than trusting a copy of
  // the Entry that could be stale by the time this effect runs — this page
  // already has the live Entries, so it looks the current body up itself
  // from `entries` instead. Read once, on mount, and immediately replaced
  // out of history state so a later Back/Forward through this exact
  // location doesn't silently re-enter edit mode.
  //
  // Vestigial since issue #75: `/history`'s own page was this mechanism's
  // only caller (its Edit action navigated to `/` this way, since it had
  // no Composer of its own), and issue #75 deleted that page outright
  // rather than redirecting it — nothing in the app sets `editEntryId`
  // today. Left in place rather than removed: it's inert, not broken (no
  // caller means this effect's `editEntryId === undefined` branch always
  // returns early), and it's exactly the kind of pre-existing behaviour a
  // route-deletion ticket shouldn't also be second-guessing. Worth a
  // dedicated follow-up if `/history` truly has no successor arriving.
  const location = useLocation();
  const navigate = useNavigate();
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only — see the comment above. Re-running on `entries` or `navigate` identity churn would fight the "consumed once" guarantee this effect exists for.
  useEffect(() => {
    const editEntryId = (location.state as { editEntryId?: string } | null)?.editEntryId;
    if (editEntryId === undefined) {
      return;
    }
    const target = entries.find((entry) => entry.id === editEntryId);
    if (target) {
      setEditingEntry(target);
    }
    navigate(".", { replace: true, state: null });
  }, []);

  return (
    <Shell
      // "Composer", not "meologue". The app's name belonged in this bar
      // while the Composer WAS the root screen; ADR 0036 made the chat list
      // the root and this a destination pushed over it, so at the wide
      // breakpoint the two panes sat side by side both saying "meologue"
      // and neither saying which one this is.
      title="Composer"
      // No `action` slot here any more (issue #75): History and Settings
      // both moved into the persistent Nav — History by being deleted
      // outright (this page already renders the same Entries through the
      // same History component; see history.tsx's own comment), Settings
      // by becoming Nav's fourth destination instead of an app-bar gear.
      back={<BackToChats />}
      message={message}
      search={{ query, onQueryChange: setQuery, onDismiss: () => setQuery("") }}
      footer={
        <History
          entries={orderedEntries}
          syncEnabled={syncEnabled}
          query={query}
          onEdit={setEditingEntry}
          onDelete={removeEntry}
          onRefer={handleRefer}
          onToggleTask={handleToggleTask}
          dayReferrers={dayReferrers}
          tasks={tasks}
          completedTasks={completedTasks}
          events={events}
          projects={projects}
          onCompleteTask={handleCompleteTask}
          onOpenTask={openTaskOverlay}
          seek={seek}
          onSeekNeedsOlder={handleSeekNeedsOlder}
          onSeekSettled={settleSeek}
        />
      }
      composerSlot={
        <Composer
          ref={composerRef}
          onSend={handleSend}
          disabled={disabled}
          editingEntry={editingEntry}
          onCommitEdit={handleCommitEdit}
          onCancelEdit={handleCancelEdit}
          recentEntries={entries}
          searchEntries={search}
        />
      }
      // `shown`, not `entries`: while a search is narrowing this thread the
      // pin should follow what's actually on screen.
      //
      // `pagination` is issue #79's own "load older" glue — passed through
      // unconditionally rather than only while `query` is empty, because
      // Search is unbounded (ADR 0014's search() reads unpaged) and
      // whatever page History has already loaded stays available to widen
      // further once the reader dismisses Search and returns to it.
      // ownsBottomAlignment (issue #83): History is virtualized and handles
      // its own bottom alignment via a leading spacer sized off its own
      // virtualizer — see PinnedThreadConfig's own comment for why Shell's
      // plain `min-h-full justify-end` treatment has to stand down for it.
      // `seeking` (issue #142, extended to an Entry target by #143):
      // disengages the pin for exactly as long as a Reference seek is
      // paging through older Entries — see
      // use-pinned-scroll.ts's own `seeking` option for why this has to be
      // a forced override rather than merely "don't re-pin," and its own
      // comment for why leaving it running would drag the reader back to
      // the newest Entry the instant the seek's first page landed.
      pinnedThread={{
        watch: shown,
        forceToNewest: sendSignal,
        pagination,
        ownsBottomAlignment: true,
        seeking: seek !== null,
      }}
    >
      {!syncEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to reach your other Devices.
        </p>
      )}

      {/* Issue #181's Task detail overlay — `TaskDetailView` reused
          wholesale (task-detail-view.tsx's own header comment names this
          exact door as the gap it left open), not a second, stripped-down
          Task surface. `section` stays `null` here: resolving the Task's
          own Section would need a `listSections` query this page has no
          other use for, and the one thing it buys is the breadcrumb's
          second segment — a cosmetic gap, not a functional one, left for
          a follow-up rather than growing this page's own store surface
          for it. `prevTask`/`nextTask` stay `null` and `onNavigate` is
          never called: the Composer has no "list of Tasks" for a chevron
          to step through the way Today or a Project's own view does. */}
      {openTask !== null && (
        <TaskDetailView
          task={openTask}
          project={openTaskProject}
          section={null}
          projects={projects}
          labels={labels}
          prevTask={null}
          nextTask={null}
          onClose={closeTaskOverlay}
          onNavigate={() => {}}
          onRename={(content) => renameTask(openTask.id, content)}
          onComplete={() => handleCompleteTask(openTask)}
          onUncomplete={() => uncompleteTask(openTask.id)}
          onOpenSchedule={() => setSchedulingOpen(true)}
          onSetProject={(projectId) => setTaskProject(openTask.id, projectId)}
          onSetLabels={(labelIds) => setTaskLabels(openTask.id, labelIds)}
          onSetDescription={(description) => setTaskDescription(openTask.id, description)}
          comments={commentsForTask(comments, openTask.id)}
          onAddComment={(text) => addComment(openTask.id, text)}
          onEditComment={editComment}
          onRemoveComment={removeComment}
          events={events.filter((event) => event.taskId === openTask.id)}
        />
      )}

      {openTask !== null && schedulingOpen && (
        <TaskScheduleSheet
          task={openTask}
          open={true}
          onOpenChange={setSchedulingOpen}
          onSetDate={setTaskDate}
          onSetDeadline={setTaskDeadline}
          onSetPriority={setTaskPriority}
        />
      )}
    </Shell>
  );
}
