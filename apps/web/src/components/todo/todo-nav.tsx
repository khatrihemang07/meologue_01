import { NavLink } from "react-router";
import { TODO_BAR_DESTINATIONS } from "@/components/todo/todo-nav-destinations";
import { useTodoSidebarLayout } from "@/hooks/use-wide-layout";
import { cn } from "@/lib/utils";

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
          // `replace` (ADR 0079's follow-up, ADR 0086 — "Todo's own views
          // are interior state, not departures"): moving between Todo's
          // own rows is interior state, not a departure from Todo, so it
          // must not push a history entry the way a plain `NavLink` would
          // by default. A reader who taps through several of these and
          // then presses Back leaves Todo in one press, exactly as if
          // they had opened only the last one.
          replace
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
