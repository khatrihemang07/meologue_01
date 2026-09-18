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
