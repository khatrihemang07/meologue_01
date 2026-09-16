import { NavLink } from "react-router";
import { TODO_BAR_DESTINATIONS } from "@/components/todo/todo-nav-destinations";
import { useTodoSidebarLayout } from "@/hooks/use-wide-layout";
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
 * **Four rows, not six (ANAV-01, fork ADR 0082, resolved).** This used to
 * grow one row per view — Inbox, Today, Projects, then Filters (issue
 * #185) and Activity (issue #248) appended the same way, six by the time
 * ADR 0082 forked and deliberately left the count open. Real Todoist
 * Android, read live (v12278), carries exactly four: Inbox, Today,
 * Upcoming, Browse. ANAV-05 (parity ledger) traced this bar's 46 CSS px
 * tap target — under the 48dp minimum — directly to the old count: "six
 * tabs in 426px is what forces it." `TODO_BAR_DESTINATIONS`
 * (todo-nav-destinations.ts) is now the narrower four-item list this
 * component renders, not `TODO_NAV_DESTINATIONS`'s full six — Filters,
 * Activity and Projects moved to `/todo/browse` (`browse-view.tsx`)
 * instead, reachable through the fourth row rather than a row of their
 * own. `todo-nav-destinations.ts`'s own header comment has the full
 * reasoning for why splitting the list this way doesn't reopen defect
 * 33's "unreachable from either navigation" failure mode.
 *
 * **Hides itself at the 1200px sidebar breakpoint (issue #223's second
 * half, moved by the owner's amendment to ADR 0076).** `TodoSidebar`
 * (`todo-page.tsx`, mounted as a second column inside Todo's own subtree)
 * takes over this component's own role — "a second, co-equal way into the
 * same Tasks" — the moment there is room for it, and it carries the
 * identical `aria-label="Todo"` this component's own `<nav>` already
 * does. Leaving both mounted at once would put two nav landmarks with the
 * same name on screen simultaneously — exactly the duplicate-landmark
 * defect `chat-list-pane.tsx`'s own header comment already argues a
 * `<div>` instead of a `<header>` into existence to avoid, reappearing
 * here on the same axis rebuilt as two `<nav>`s instead of two
 * `<header>`s. The breakpoint itself moved from 900px to 1200px along with
 * `TodoSidebar`'s own: below 1200px the sidebar no longer renders at all
 * (the chat list pane takes that space instead, per the amendment), so this
 * bar has to keep covering the 900-1199px band it used to hand off at 900.
 * Below 900px this renders exactly as it always has — the load-bearing
 * narrow-viewport constraint issue #223's own brief names is that nothing
 * here changes for it.
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
 * only the one. ANAV-01's four-row bar (above) narrows *which* list this
 * component itself renders from (`TODO_BAR_DESTINATIONS`, not the full
 * `TODO_NAV_DESTINATIONS`) without reintroducing two independently
 * hand-maintained lists — see that file's own header comment for why the
 * two are still allowed to diverge in *content* without reopening defect
 * 33's "unreachable from either" failure.
 */
export function TodoNav() {
  const sidebarWide = useTodoSidebarLayout();
  if (sidebarWide) {
    return null;
  }

  return (
    <nav
      aria-label="Todo"
      className="flex shrink-0 items-center gap-0.5 border-t border-border bg-background px-1 [padding-bottom:env(safe-area-inset-bottom)]"
    >
      {TODO_BAR_DESTINATIONS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          // `min-w-0` is load-bearing, not tidying. A flex item defaults to
          // `min-width: auto`, so `flex-1` cannot shrink it below its own
          // content: the longest label ("Upcoming") held every tab at a
          // 74px floor. Measured at 320px with six tabs, the bar overflowed
          // — scrollWidth 369 against clientWidth 320 — and pushed Filters
          // clean past the viewport, making it unreachable on a small phone.
          // That is the same "destination you cannot reach" defect adding
          // Upcoming to this list was meant to end, reintroduced one tab
          // along. `min-w-0` plus a truncating label lets the bar adapt at
          // any width instead of breaking past a threshold, so a fifth row
          // (there is none now — four is the fixed, measured count) would
          // still degrade legibly rather than silently dropping one.
          //
          // `h-20` (80 CSS px): Todoist Android's own measured item height
          // (v12278: 225 device px / 2.8125 = 80.0 CSS px), replacing the
          // old padding-driven height nothing had measured against it. A
          // fixed height, not padding, is what keeps the row this tall
          // regardless of how the pill/label inside it are laid out.
          className="flex h-20 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 text-xs transition-colors hover:bg-muted"
        >
          {({ isActive }) => (
            <>
              {/*
                ANAV-01/ANAV-05: the active pill sits behind the ICON
                ALONE, not the label — proven geometrically on the live
                device (icon glyph and pill share one centre; the label
                sits 13-23 device px below the pill's own lowest painted
                pixel, no overlap). `rounded-full` on a box wider than it
                is tall is a stadium, not the ellipse Todoist actually
                paints (90px wide at the top, 158px flat across the
                centre, 96px at the bottom, ~84px tall — no single
                border-radius reproduces that curve). This is a
                deliberate approximation, not a miss to chase: a stadium
                reads as "a pill behind the icon" close enough, and
                chasing the exact ellipse would mean a bespoke clip-path
                for one nav row.
              */}
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-8 w-11 items-center justify-center rounded-full transition-colors",
                  isActive && "bg-[color:var(--td-nav-active-pill)]",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-4",
                    isActive
                      ? "text-[color:var(--td-nav-active-icon)]"
                      : "text-[color:var(--td-nav-inactive)]",
                  )}
                />
              </span>
              {/* The label's own ink is a DIFFERENT red from the icon's
                  when active — the live device reads `rgb(240,127,117)`
                  on the label against `rgb(222,76,74)` on the icon,
                  deliberately not the same tone. `--td-nav-active-label`
                  and `--td-nav-active-icon` are two separate tokens for
                  exactly that reason (todo-nav-destinations.ts's sibling,
                  index.css's own comment on this pair, has the token
                  reasoning). */}
              <span
                className={cn(
                  "max-w-full truncate",
                  isActive
                    ? "text-[color:var(--td-nav-active-label)]"
                    : "text-[color:var(--td-nav-inactive)]",
                )}
              >
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
