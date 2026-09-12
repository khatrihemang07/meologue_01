/**
 * The single list of Todo's flat, single-view destinations — Inbox,
 * Today, Upcoming, Projects, Activity, Filters — shared by `todo-nav.tsx`
 * (the bottom bar below 900px) and `todo-sidebar.tsx` (its desktop
 * replacement at 900px and up).
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
 * `to` and `Icon` are load-bearing for both navigations; `label` is the
 * base wording `todo-nav.tsx` renders verbatim. `todo-sidebar.tsx` is free
 * to render its own wording for a given row (it already did, pre-dating
 * this file, for "Filters & Labels" against this list's plain "Filters" —
 * issue #229/NAV-06) precisely because the reachability question this
 * file answers is about the `to` path, not the label text: Todoist's own
 * sidebar and command surfaces don't always agree on wording either. What
 * this list forecloses is a destination existing in one navigation and
 * not the other — not the two navigations rendering identical prose for
 * the destinations they share.
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
 * happened to be extracted from.
 */
import {
  CalendarCheck,
  CalendarClock,
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
