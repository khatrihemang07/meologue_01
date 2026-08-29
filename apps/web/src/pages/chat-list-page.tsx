import { ChatListPane } from "@/components/chat-list-pane";
import { useWideLayout } from "@/hooks/use-wide-layout";

/**
 * What `/` renders, which depends on how wide the window is.
 *
 * On a narrow window the list is the whole screen, so this is the list.
 *
 * At the wide breakpoint `chat-shell-layout.tsx` already has the list pinned
 * to the left, so rendering it again here would show it twice. What `/`
 * means there instead is "nothing chosen yet" — the state ADR 0018 flagged
 * as unreachable for a single-thread app, and which four real destinations
 * now make representable. It gets an explicit pane saying so rather than an
 * arbitrary default destination, because silently opening the Composer would
 * make `/` and `/composer` indistinguishable in the address bar while
 * meaning different things.
 */
export function ChatListPage() {
  const wide = useWideLayout();

  if (!wide) {
    return <ChatListPane />;
  }

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center p-8">
      <p className="text-center text-muted-foreground text-sm">
        Choose a conversation from the list.
      </p>
    </div>
  );
}
