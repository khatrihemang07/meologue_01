import { ListTodo } from "lucide-react";
import { NavLink } from "react-router";
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
 * One row today (Inbox). Issue #169's Today is a second row added to
 * `VIEWS` below — adding a view is adding a row to a list, per this
 * ticket's own brief, not restructuring this component.
 */
const VIEWS = [{ to: "/todo/inbox", label: "Inbox", Icon: ListTodo }] as const;

export function TodoNav() {
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
