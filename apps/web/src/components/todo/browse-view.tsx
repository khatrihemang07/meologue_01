/**
 * ANAV-01 (fork ADR 0082, resolved): the hub `TodoNav`'s fourth row
 * (`/todo/browse`, `todo-nav.tsx`) opens — Todoist Android's own "Browse"
 * screen, read live (v12278), minus everything on it meologue has no
 * equivalent surface for.
 *
 * **Four rows, not real Todoist's eleven.** The live screen carries a
 * profile header (avatar/name/notifications/settings), a "Try Pro for
 * free" promo, Search, Filters & Labels, Reporting, a "My Projects"
 * section (heading, Add/collapse controls, then each Project as its own
 * row with a task-count badge), "Manage projects", "Add a team", "Browse
 * templates" and "Help & resources". This component builds only the four
 * that name a real meologue destination — Search (`/todo/search`),
 * Filters & Labels (`/todo/filters`), Reporting (`/todo/activity`) and
 * Projects (`/todo/projects`) — and deliberately skips the rest: there is
 * no meologue account/profile surface, no paid tier, no team feature, no
 * template gallery and no help centre for any of those rows to open.
 * Building a row with nowhere real to send a reader would be worse than
 * not having the row.
 *
 * **Projects is one row here, not the full tree.** Real Todoist's "My
 * Projects" section is a whole list of individual Project rows with
 * counts; this component's own "Projects" row instead opens
 * `/todo/projects` (`projects-view.tsx`), which already lists every
 * Project. Duplicating that tree here, a second place with its own copy
 * of the same list, is exactly the two-lists-drift shape
 * `todo-nav-destinations.ts`'s own header comment already warns against
 * for a different pair of lists.
 *
 * **Why this exists at all.** ANAV-01 shrank `TodoNav`'s bottom bar from
 * six rows to Todoist's own four (Inbox, Today, Upcoming, Browse) —
 * ANAV-05 (parity ledger) traced the bar's 46 CSS px tap target, under
 * the 48dp minimum, directly to the old six-row count. Filters, Activity
 * and Projects lost their own row in the bar as a result; this screen is
 * where each of those three, plus Search (unreachable from the bar at
 * any width below the 1200px sidebar before this ticket — ANAV-01's own
 * brief), lands instead. `todo-nav-destinations.test.tsx`'s reachability
 * test is what proves every destination `TODO_BAR_DESTINATIONS` drops is
 * still one tap away from here.
 *
 * **Wording follows `todo-sidebar.tsx`, not `todo-nav-destinations.ts`'s
 * plain labels**, the same departure that file's own header comment
 * already permits and explains: "Filters & Labels" (issue #229/NAV-06)
 * and "Reporting" (parity ledger NAV-01/NAV-11) are this app's own
 * measured, Todoist-matching wording for `/todo/filters` and
 * `/todo/activity`; the reachability question the shared list answers is
 * about the `to` path, never the label text.
 */
import { FolderKanban, History, ListFilter, Search as SearchIcon } from "lucide-react";
import { Link } from "react-router";

interface BrowseRow {
  to: string;
  label: string;
  Icon: typeof SearchIcon;
}

/**
 * Exported for `browse-view.test.tsx` and
 * `todo-nav-destinations.test.tsx`'s own reachability test, rather than
 * either re-typing this same four-row list a second time or rendering
 * the whole component just to read its `href`s back out.
 */
export const BROWSE_DESTINATIONS: readonly BrowseRow[] = [
  { to: "/todo/search", label: "Search", Icon: SearchIcon },
  { to: "/todo/filters", label: "Filters & Labels", Icon: ListFilter },
  { to: "/todo/activity", label: "Reporting", Icon: History },
  { to: "/todo/projects", label: "Projects", Icon: FolderKanban },
];

export function BrowseView() {
  return (
    <nav aria-label="Browse" className="flex flex-col p-1">
      {BROWSE_DESTINATIONS.map(({ to, label, Icon }) => (
        <Link
          key={to}
          to={to}
          className="flex items-center gap-3 rounded-md px-2 py-3 text-sm hover:bg-muted"
        >
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
