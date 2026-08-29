import type { CSSProperties } from "react";
import { Outlet } from "react-router";
import { ChatListPane } from "@/components/chat-list-pane";
import { PaneDivider } from "@/components/pane-divider";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { useSettingsStore } from "@/lib/settings";

/**
 * The window, and the two-level shape every page renders inside (ADR 0036).
 *
 * This is the element that used to be `Shell`'s outermost div. Moving it out
 * here is what lets the chat list be a *pane* rather than chrome: `Shell` is
 * now one pane among the panes this lays out, so it sizes to its parent
 * instead of to the window, and the list can sit beside it without either
 * one trying to be the window at the same time.
 *
 * `--keyboard-inset` and `--safe-bottom` are computed once here and
 * inherited by everything below, for the reason their own hook records:
 * three bottom-edge components each running their own viewport listeners
 * would disagree by a frame about one question the shell already knows the
 * answer to.
 *
 * The list pane's width is clamped in CSS rather than in JS, so a stored
 * width that no longer fits — a laptop preference met on a smaller window —
 * is corrected on every render instead of being silently rewritten in
 * storage the first time the app opens somewhere narrower.
 */
export function ChatShellLayout() {
  const keyboard = useKeyboardInset();
  const wide = useWideLayout();
  const listWidth = useSettingsStore((state) => state.listWidth);

  return (
    <div
      className="flex h-[calc(100svh-var(--keyboard-inset))] w-full overflow-hidden bg-background [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]"
      style={
        {
          "--keyboard-inset": `${keyboard.inset}px`,
          "--safe-bottom": keyboard.visible ? "0px" : "env(safe-area-inset-bottom)",
          "--list-w": `${listWidth}px`,
        } as CSSProperties
      }
    >
      {wide && (
        <>
          <div className="flex w-[clamp(260px,var(--list-w),min(560px,calc(100vw-360px)))] shrink-0 overflow-hidden">
            <ChatListPane />
          </div>
          <PaneDivider />
        </>
      )}
      <Outlet />
    </div>
  );
}
