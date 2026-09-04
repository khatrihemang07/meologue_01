/**
 * Every saved Filter (issue #185, CONTEXT.md's Filter entry: "a saved
 * query over Tasks") — the Filter-shaped sibling of projects-view.tsx,
 * reached from `TodoNav`'s own fifth row (`todo-nav.tsx`), the same "one
 * more row" extension ADR 0049 already predicted.
 *
 * Deliberately no inline "type a name, pick a colour, hit Add" form the
 * way `ProjectsView` has one: a Filter's whole point is its query, and a
 * one-line quick-add control has nowhere to put the live preview
 * criterion 7 asks for. "New Filter" instead opens `/todo/filters/new`
 * — `FilterView` (filter-view.tsx) in its create mode, the one editor
 * this ticket builds for both creating and refining a query.
 */
import type { Filter } from "@meologue/core";
import { Link } from "react-router";

export interface FiltersViewProps {
  filters: Filter[];
}

export function FiltersView({ filters }: FiltersViewProps) {
  return (
    <div className="flex flex-col gap-4 p-3">
      <Link
        to="/todo/filters/new"
        className="flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-muted"
      >
        New Filter
      </Link>

      {filters.length === 0 ? (
        <p className="px-1 text-center text-muted-foreground text-sm">
          No Filters yet. A Filter is a saved query — add one above to see it here.
        </p>
      ) : (
        <ul className="flex flex-col">
          {filters.map((filter) => (
            <li
              key={filter.id}
              className="flex items-center gap-2 border-border border-b py-2 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: filter.colour }}
              />
              <Link
                to={`/todo/filters/${filter.id}`}
                className="min-w-0 flex-1 truncate text-sm hover:underline"
              >
                {filter.name}
              </Link>
              <span className="max-w-[40%] shrink truncate text-muted-foreground text-xs">
                {filter.query}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
