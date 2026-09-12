import { NavLink } from "react-router";
import { TODO_NAV_DESTINATIONS } from "@/components/todo/todo-nav-destinations";
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
 * a second time: a third row appended to what was once `VIEWS` below,
 * nothing else in this component touched — "adding a view is adding a
 * row to a list," this ticket's own brief, held in practice rather than
 * only argued in the ADR that predicted it. `/todo/projects` names the
 * list of every Project (`projects-view.tsx`); a single Project's own
 * screen (`/todo/projects/:projectId`, `project-view.tsx`) has no row of
 * its own here — the same reason `/reflect/:sessionId` isn't a `Nav`
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
 * **Two lists, not one — the miss this file used to ship, twice.** Issue
 * #223 shipped `/todo/upcoming` and added it to `todo-sidebar.tsx`'s own
 * rows in the same change, but never to this file's own list of views:
 * this component and the sidebar used to each keep a separate list a new
 * destination had to be added to twice, not one shared source of truth
 * read at two widths, and #223 only touched one of them. Above the wide
 * breakpoint that was invisible — the sidebar carried a real link — so it
 * shipped anyway, and `/todo/upcoming` stayed unreachable on Android and
 * at any phone width for a full release. The identical miss then
 * recurred in the other direction: `/todo/projects` lived in this file's
 * own list from the start but was never added to the sidebar's — parity
 * ledger defect 33. `TODO_NAV_DESTINATIONS` (todo-nav-destinations.ts) is
 * the fix for the *class*: one list this component and `TodoSidebar` both
 * render from, so neither can drift from the other's set of destinations
 * again — `todo-nav-destinations.test.tsx` is the test that holds that
 * shut. "Adding a view is adding a row to a list" (above) was never
 * false; it just undercounted how many lists there were, until there was
 * only the one.
 */
export function TodoNav() {
  const wide = useWideLayout();
  if (wide) {
    return null;
  }

  return (
    <nav
      aria-label="Todo"
      className="flex shrink-0 items-center gap-0.5 border-t border-border bg-background px-1 py-1.5 [padding-bottom:env(safe-area-inset-bottom)]"
    >
      {TODO_NAV_DESTINATIONS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              // `min-w-0` is load-bearing, not tidying. A flex item defaults to
              // `min-width: auto`, so `flex-1` cannot shrink it below its own
              // content: the longest label ("Upcoming") held every tab at a
              // 74px floor. Measured at 320px with six tabs, the bar overflowed
              // — scrollWidth 369 against clientWidth 320 — and pushed Filters
              // clean past the viewport, making it unreachable on a small phone.
              // That is the same "destination you cannot reach" defect adding
              // Upcoming to this list was meant to end, reintroduced one tab
              // along. `min-w-0` plus a truncating label lets the bar adapt at
              // any width instead of breaking past a threshold, so a seventh
              // row degrades legibly rather than silently dropping one.
              "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted",
              isActive && "bg-muted text-foreground",
            )
          }
        >
          <Icon aria-hidden="true" className="size-4" />
          <span className="max-w-full truncate">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
