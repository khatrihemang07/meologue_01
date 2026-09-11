import { ArrowLeft } from "lucide-react";
import { Link, useLocation } from "react-router";
import { useWideLayout } from "@/hooks/use-wide-layout";

/**
 * The way back out of a destination and onto the root screen (ADR 0036).
 *
 * Renders nothing at the wide breakpoint for Composer, Reflection, Digest
 * and Settings, and that is the decision rather than an oversight: the chat
 * list is pinned beside this pane there, so "back" has nowhere to go that
 * the reader cannot already see and click. ADR 0018's "an always-reachable
 * destination doesn't need Back" is the same argument, applied to a
 * destination that is reachable because it is on screen rather than because
 * a nav bar is.
 *
 * **Todo is the one destination where that premise stopped holding (issue
 * #248, ADR 0076).** At the wide breakpoint its own pane shows
 * `TodoSidebar` instead of `ChatListPane` (ADR 0076), and the sidebar is
 * navigation *within* Todo — it carries no link out to the other four
 * Destinations. So this still renders on `/todo/*` at every width; the
 * `isTodo` test below mirrors `chat-shell-layout.tsx`'s own route test for
 * exactly the same route.
 *
 * A real `<Link to="/">` rather than `history.back()`: a reader who opened
 * `/composer` directly — a bookmark, a reload, a shared URL — has no history
 * entry to go back to, and a Back control that does nothing on a cold load
 * is worse than one that always lands somewhere sensible. The two
 * second-level screens (`/reflect/list`, `/digest/:period/:date`) keep their
 * own history-based Back, because theirs genuinely means "the screen I came
 * from" rather than "the root".
 */
export function BackToChats() {
  const wide = useWideLayout();
  const location = useLocation();
  // Same exact-or-slash test as chat-shell-layout.tsx's own `isTodo`, and
  // for the same reason given there: a bare `startsWith("/todo")` would
  // also match a future `/todoist` or `/todo-archive` route.
  const isTodo = location.pathname === "/todo" || location.pathname.startsWith("/todo/");
  if (wide && !isTodo) return null;

  return (
    <Link
      to="/"
      aria-label="Back to chats"
      // size-11 (44px) tap target and hover treatment, matching every other
      // app-bar icon control in this app.
      className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
    </Link>
  );
}
