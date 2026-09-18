import type { Filter, Label } from "@meologue/core";
import { Link } from "react-router";

export interface FiltersViewProps {
  filters: Filter[];
  /** This component's own header comment on why this is optional and read-only here. */
  labels?: Label[];
}

export function FiltersView({ filters, labels = [] }: FiltersViewProps) {
  return (
    <div className="flex flex-col gap-4 p-3">
      <Link
        to="/todo/filters/new"
        className="flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-muted"
      >
        New Filter
      </Link>

      <h2 className="font-medium text-sm">My Filters</h2>

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

      <div className="flex flex-col gap-2 border-border border-t pt-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Labels</h2>
          <Link to="/todo/labels" className="text-muted-foreground text-xs hover:underline">
            Manage Labels
          </Link>
        </div>
        {labels.length === 0 ? (
          <p className="px-1 text-center text-muted-foreground text-sm">
            No Labels yet. Add one from Manage Labels, or type "@name" while adding a Task.
          </p>
        ) : (
          <ul className="flex flex-col">
            {labels.map((label) => (
              <li
                key={label.id}
                className="flex items-center gap-2 border-border border-b py-2 last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: label.colour }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{label.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
