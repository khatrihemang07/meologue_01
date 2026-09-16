/**
 * The single list of Todo's flat, single-view destinations — Inbox,
 * Today, Upcoming, Projects, Activity, Filters — read by `todo-sidebar.tsx`
 * (unchanged: every row, always) and, until ANAV-01, by `todo-nav.tsx`'s
 * bottom bar too, verbatim.
 *
 * **Why this file exists: defect 33's own root cause, not just its
 * symptom.** Before this file, each of those two components kept its own
 * copy of this list — `todo-nav.tsx`'s `VIEWS` and the hand-written
 * `CountRow` calls inside `TodoSidebar` — and nothing tied the two
 * together. That produced the exact same defect twice: issue #223 added
 * `/todo/upcoming` to the sidebar's own list but not to `todo-nav.tsx`'s
 * (todo-nav.tsx's own header comment), and then `/todo/projects` shipped
 * in `todo-nav.tsx`'s `VIEWS` but was never added to the sidebar's
 * `CountRow` list at all — the sidebar only ever reached Projects through
 * its separate "My Projects" heading/tree, so at any width ≥900px there
 * was no `CountRow` for it and no shared source of truth to have caught
 * the gap. A destination that exists in one list and not the other is
 * unreachable at whichever width drops it, since `todo-nav.tsx` hides
 * itself the instant `todo-sidebar.tsx` takes over (ADR 0076) — there is
 * no third path back to it. Two lists a human has to remember to update
 * twice will eventually only get updated once; one list neither component
 * can quietly fall behind on is the actual fix, with
 * `todo-nav-destinations.test.tsx`'s own parity test as the check that
 * holds it shut.
 *
 * **ANAV-01 (fork ADR 0082, left open) split this list in two, on
 * purpose, without reopening the defect above.** The owner ruled meologue
 * matches real Todoist Android's bar — four tabs (Inbox, Today, Upcoming,
 * Browse), not six — both because that is what Todoist itself carries and
 * because ANAV-05 (parity ledger) traced the bar's 46 CSS px tap target,
 * under the 48dp floor, directly to "six tabs in 426px." `TODO_BAR_
 * DESTINATIONS` below is the narrower four-item list `todo-nav.tsx` now
 * renders; `TODO_NAV_DESTINATIONS` (unchanged, still every flat
 * destination) stays `todo-sidebar.tsx`'s own source, verbatim, exactly as
 * before this ticket. That is a real, deliberate divergence between the
 * two lists — the shape defect 33 exists to prevent — so it does not
 * repeat defect 33's actual failure mode (a destination silently
 * unreachable from *anywhere* at some width) only because a THIRD path
 * now exists for everything the bar drops: `/todo/browse`
 * (`browse-view.tsx`), reachable from the bar's own fourth tab. Filters,
 * Activity and Projects — the three destinations this file's own list
 * still carries that the bar no longer links directly — are each one tap
 * away through Browse's own rows instead. `todo-nav-destinations.test.tsx`
 * no longer asserts "every destination is in both lists" (now false by
 * construction); it asserts the invariant this split actually depends on
 * — every destination in `TODO_NAV_DESTINATIONS` is reachable from the
 * bar OR from Browse — which is the direct descendant of defect 33's own
 * fix: "reachable from *some* fixed, always-on-screen door," not "listed
 * identically in two components."
 *
 * `to` and `Icon` are load-bearing for both navigations; `label` is the
 * base wording `todo-nav.tsx` renders verbatim. `todo-sidebar.tsx` is free
 * to render its own wording for a given row (it already did, pre-dating
 * this file, for "Filters & Labels" against this list's plain "Filters" —
 * issue #229/NAV-06) precisely because the reachability question this
 * file answers is about the `to` path, not the label text: Todoist's own
 * sidebar and command surfaces don't always agree on wording either. What
 * this list forecloses is a destination existing in one navigation and
 * not the other — not the two navigations rendering identical prose for
 * the destinations they share. Browse (`browse-view.tsx`) follows the
 * identical rule for its own rows: "Filters & Labels" and "Reporting"
 * there match `todo-sidebar.tsx`'s own wording, not this list's plain
 * "Filters"/"Activity", for the same reason.
 *
 * **Order matches real Todoist's own sidebar, read live (parity ledger
 * NAV-01, flow 6): Inbox, Today, Upcoming, Filters, Activity ("Reporting"
 * in `todo-sidebar.tsx`'s own wording), then Projects ("My Projects").**
 * `todo-sidebar.tsx` renders Projects separately (its own "My Projects"
 * heading and tree, not a `CountRow`), so this order only actually
 * reorders `todo-nav.tsx`'s bottom bar — previously Inbox, Today,
 * Upcoming, Projects, Activity, Filters, an order nothing had measured
 * against Todoist. Unifying the two lists meant picking one order, and
 * the sidebar's pre-existing Filters-before-Activity order was already
 * the measured one; this keeps it rather than the mobile bar's
 * unmeasured order winning by accident of whichever file this list
 * happened to be extracted from. `TODO_BAR_DESTINATIONS` below preserves
 * this same relative order for the three it keeps (Inbox, Today,
 * Upcoming) rather than re-deriving it, then appends Browse — the one
 * entry with no equivalent row in this list at all, since Browse is a
 * hub, not a single-view destination.
 */
import {
  CalendarCheck,
  CalendarClock,
  Compass,
  FolderKanban,
  History,
  ListFilter,
  ListTodo,
} from "lucide-react";

export interface TodoNavDestination {
  to: string;
  label: string;
  Icon: typeof ListTodo;
}

export const TODO_NAV_DESTINATIONS: readonly TodoNavDestination[] = [
  { to: "/todo/inbox", label: "Inbox", Icon: ListTodo },
  { to: "/todo/today", label: "Today", Icon: CalendarCheck },
  { to: "/todo/upcoming", label: "Upcoming", Icon: CalendarClock },
  { to: "/todo/filters", label: "Filters", Icon: ListFilter },
  { to: "/todo/activity", label: "Activity", Icon: History },
  { to: "/todo/projects", label: "Projects", Icon: FolderKanban },
] as const;

// The paths `TODO_BAR_DESTINATIONS` below keeps directly, filtered out of
// `TODO_NAV_DESTINATIONS` above rather than re-typed as a second literal
// list — so the bar's three flat rows can never drift from this file's own
// `to`/`label`/`Icon` for Inbox/Today/Upcoming the way defect 33's two
// independently hand-maintained lists once did.
const BAR_KEPT_PATHS: ReadonlySet<string> = new Set([
  "/todo/inbox",
  "/todo/today",
  "/todo/upcoming",
]);

/**
 * ANAV-01: the bottom bar's own four rows — Todoist Android's measured
 * count (live, v12278), not this app's previous six. Inbox/Today/Upcoming
 * are `TODO_NAV_DESTINATIONS`'s own entries, unchanged; Browse is new here
 * and has no `TODO_NAV_DESTINATIONS` entry of its own, since it names a
 * hub screen (`browse-view.tsx`), not one flat view. `todo-nav-
 * destinations.test.tsx`'s reachability test is what proves every
 * destination this list drops (Filters, Activity, Projects) is still one
 * tap away through Browse's own rows — nothing here re-derives that
 * proof, it only defines the four `to`s a reader can reach directly from
 * the bar.
 */
export const TODO_BAR_DESTINATIONS: readonly TodoNavDestination[] = [
  ...TODO_NAV_DESTINATIONS.filter((destination) => BAR_KEPT_PATHS.has(destination.to)),
  { to: "/todo/browse", label: "Browse", Icon: Compass },
];
