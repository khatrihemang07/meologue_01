import { CalendarCheck, FolderKanban, History, ListTodo } from "lucide-react";
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
 */
const VIEWS = [
  { to: "/todo/inbox", label: "Inbox", Icon: ListTodo },
  { to: "/todo/today", label: "Today", Icon: CalendarCheck },
  { to: "/todo/projects", label: "Projects", Icon: FolderKanban },
  // Issue #184 / ADR 0056: Todo's activity log, the fourth row — exactly
  // the proof this component's own header comment already names ("a
  // third row appended to VIEWS, nothing else in this component
  // touched"), now with a fourth.
  { to: "/todo/activity", label: "Activity", Icon: History },
] as const;

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
