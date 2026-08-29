import { ChatList } from "@/components/chat-list";
import { SyncStatusIndicator } from "@/components/sync-status-indicator";

/**
 * The root screen itself: an app bar and the four rows under it.
 *
 * One component with two homes, which is the point. Below the wide
 * breakpoint `chat-list-page.tsx` renders it as the whole screen, and at or
 * above it `chat-shell-layout.tsx` renders it as the pinned left pane beside
 * whatever destination is open. Those are the same markup in two places, not
 * two implementations of one idea — the thing ADR 0018's single repositioned
 * `<nav>` was reaching for, now that there is a real screen to reposition
 * rather than a strip of chrome.
 *
 * No Back control and no `<Shell>`: this is the screen every other one is
 * pushed over, so there is nowhere for it to go back to.
 */
export function ChatListPane() {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/*
        A `<div>`, not a `<header>`. At the wide breakpoint this pane renders
        beside an open destination that has an app bar of its own, and two
        `<header>` elements at the top level of a document are two `banner`
        landmarks — the exact duplicate-landmark defect ADR 0018 argued its
        single repositioned `<nav>` into existence to avoid, reappearing on
        the other axis. The destination's own app bar is the page's banner;
        this is the list's heading, and the `<h1>` plus `chat-list.tsx`'s
        scoped `<nav aria-label="Chats">` are what name it in the
        accessibility tree.
      */}
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-border border-b px-4 [padding-top:env(safe-area-inset-top)]">
        <h1 className="font-semibold text-base">meologue</h1>
        <SyncStatusIndicator />
      </div>
      {/*
        `--safe-bottom` here rather than `env()` directly: with the persistent
        nav gone this pane owns the window's bottom edge on a narrow window,
        and the variable is what collapses that padding to nothing while a
        keyboard is up. No keyboard ever opens over this screen today, but
        the ownership rule is the same one the Composer follows and splitting
        it would leave two answers to one question.
      */}
      <div className="flex-1 overflow-y-auto [padding-bottom:var(--safe-bottom)]">
        <ChatList />
      </div>
    </div>
  );
}
