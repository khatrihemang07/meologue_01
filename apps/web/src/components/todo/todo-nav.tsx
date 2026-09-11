import {
  CalendarCheck,
  CalendarClock,
  FolderKanban,
  History,
  ListFilter,
  ListTodo,
} from "lucide-react";
import { NavLink } from "react-router";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { cn } from "@/lib/utils";

/**
 * Todo's internal navigation, scoped to Todo alone (ADR 0049 — the ADR this
 * ticket writes). Rendered only from inside a Todo view (`todo-page.tsx`'s
 * own `<Shell composerSlot={<TodoNav />}>`), the same way Shell's
 * `composerSlot` is otherwise the Composer's own docked bar — nothing about
 * Shell, `chat-list.tsx`, or any non-Todo page renders this component, so
 * it unmounts the instant a reader leaves `/todo/*` for anywhere else,
 * which is the whole of what ADR 0049 argues does not reopen ADR 0036's
 * removal of the app-wide persistent nav.
 *
 * Three rows: Inbox (issue #168), Today (issue #169) and Projects (issue
 * #171) — each a second, co-equal way into the same Tasks (ADR 0049's
 * "Today alone is enough to make navigation a question this ADR has to
 * answer"). Landing Projects here is exactly the proof this ADR asked for
 * a second time: a third row appended to `VIEWS` below, nothing else in
 * this component touched — "adding a view is adding a row to a list,"
 * this ticket's own brief, held in practice rather than only argued in
 * the ADR that predicted it. `/todo/projects` names the list of every
 * Project (`projects-view.tsx`); a single Project's own screen
 * (`/todo/projects/:projectId`, `project-view.tsx`) has no row of its own
 * here — the same reason `/reflect/:sessionId` isn't a `Nav`
 * destination (nav.tsx) either: a reader reaches it by opening a specific
 * Project, not by picking it from this bar.
 *
 * **Hides itself at the wide breakpoint (issue #223's second half).**
 * `TodoSidebar` (chat-shell-layout.tsx) takes over this component's own
 * role — "a second, co-equal way into the same Tasks" — the moment there
 * is room for a pane beside the open Destination, and it carries the
 * identical `aria-label="Todo"` this component's own `<nav>` already
 * does. Leaving both mounted at once would put two nav landmarks with the
 * same name on screen simultaneously — exactly the duplicate-landmark
 * defect `chat-list-pane.tsx`'s own header comment already argues a
 * `<div>` instead of a `<header>` into existence to avoid, reappearing
 * here on the same axis rebuilt as two `<nav>`s instead of two
 * `<header>`s. Below the breakpoint this renders exactly as it always
 * has — the load-bearing narrow-viewport constraint issue #223's own
 * brief names is that nothing here changes for it.
 *
 * **Two lists, not one — the miss this file's `Upcoming` row now fixes.**
 * Issue #223 shipped `/todo/upcoming` and added it to `todo-sidebar.tsx`'s
 * own rows in the same change, but never to `VIEWS` below: this component
 * and the sidebar are separate lists a new destination has to be added to
 * twice, not one shared source of truth read at two widths, and #223 only
 * touched one of them. Above the wide breakpoint that was invisible — the
 * sidebar carried a real link — so it shipped anyway, and `/todo/upcoming`
 * stayed unreachable on Android and at any phone width for a full release
 * until this paragraph's own fix. "Adding a view is adding a row to a
 * list" (above, and again below) was never false; it just undercounted
 * how many lists there are.
 */
const VIEWS = [
  { to: "/todo/inbox", label: "Inbox", Icon: ListTodo },
  { to: "/todo/today", label: "Today", Icon: CalendarCheck },
  // Issue #223 added this same destination to todo-sidebar.tsx (the wide
  // breakpoint's own list) but not here, leaving /todo/upcoming
  // unreachable below the wide breakpoint for a full release — see this
  // file's own header comment. Positioned after Today, matching
  // todo-sidebar.tsx's own Inbox/Today/Upcoming/Filters order (parity
  // ledger NAV-01) so the two lists agree.
  { to: "/todo/upcoming", label: "Upcoming", Icon: CalendarClock },
  { to: "/todo/projects", label: "Projects", Icon: FolderKanban },
  // Issue #184 / ADR 0056: Todo's activity log, the fourth row — exactly
  // the proof this component's own header comment already names ("a
  // third row appended to VIEWS, nothing else in this component
  // touched"), now with a fourth.
  { to: "/todo/activity", label: "Activity", Icon: History },
  // Issue #185, ADR 0058: every saved Filter, the fifth row — the
  // identical extension, once more. `/todo/filters` names the list of
  // every Filter (`filters-view.tsx`); a single Filter's own screen
  // (`/todo/filters/:filterId`, `filter-view.tsx`) has no row of its own
  // here, mirroring `/todo/projects/:projectId`'s own absence above for
  // the identical reason.
  { to: "/todo/filters", label: "Filters", Icon: ListFilter },
] as const;

export function TodoNav() {
  const wide = useWideLayout();
  if (wide) {
    return null;
  }

  return (
    <nav
      aria-label="Todo"
      className="flex shrink-0 items-center gap-1 border-t border-border bg-background px-2 py-1.5 [padding-bottom:env(safe-area-inset-bottom)]"
    >
      {VIEWS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              "flex flex-1 flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted",
              isActive && "bg-muted text-foreground",
            )
          }
        >
          <Icon aria-hidden="true" className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
