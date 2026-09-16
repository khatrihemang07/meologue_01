import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { useWideLayout } from "@/hooks/use-wide-layout";

/**
 * The way back out of a destination and onto the root screen (ADR 0036).
 *
 * Renders nothing at the wide breakpoint, on every destination, and that is
 * the decision rather than an oversight: the chat list is pinned beside
 * this pane there, so "back" has nowhere to go that the reader cannot
 * already see and click. ADR 0018's "an always-reachable destination
 * doesn't need Back" is the same argument, applied to a destination that is
 * reachable because it is on screen rather than because a nav bar is.
 *
 * **Todo carried a special case here for one cycle (issue #248, ADR
 * 0076), and it is gone.** At the wide breakpoint Todo's own pane used to
 * show `TodoSidebar` instead of `ChatListPane`, and the sidebar carried no
 * link out to the other four Destinations — so this kept rendering on
 * `/todo/*` at every width, the one route where the wide-breakpoint check
 * above didn't apply. The owner overruled ADR 0076: `chat-shell-layout.tsx`'s
 * pane is always `ChatListPane` now, `/todo/*` included, with `TodoSidebar`
 * mounted separately, as a second column inside Todo's own subtree
 * (`todo-page.tsx`). The chat list is on screen beside Todo at the wide
 * breakpoint exactly the way it is beside Composer, Reflection, Digest and
 * Settings, so the premise the carve-out existed for is gone, and so is the
 * carve-out — this component no longer has to know Todo is a route at all.
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
  if (wide) return null;

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
