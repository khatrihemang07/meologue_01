import type { CSSProperties } from "react";
import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { destinationForPath } from "@/components/chat-list";
import { ChatListPane } from "@/components/chat-list-pane";
import { PaneDivider } from "@/components/pane-divider";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { writeLastDestination } from "@/lib/last-destination";
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
 *
 * There used to be a second whole-document switch here: `data-surface="todo"`
 * (issue #223), claimed by this layout while on a `/todo/*` route and by
 * `composer-page.tsx` while its Task detail overlay was open, ref-counted
 * because those two claimants share no ancestor. ADR 0085 (superseding ADR
 * 0069) deletes it — Todoist's palette and font are meologue's own now,
 * unconditionally, in `index.css`'s plain `:root`/`.dark`, so there is
 * nothing left to claim or release here. Entering or leaving Todo repaints
 * nothing behind it any more, which was the whole point: the switch itself,
 * not Todoist's palette, was what made opening a Task recolour and re-font
 * the screen behind it for a frame.
 *
 * `useLocation` rather than reading `window.location` keeps `writeLastDestination`
 * below reacting to every route change rather than only to a remount — this
 * layout persists across navigation, so a plain read at mount would freeze
 * it at whichever Destination happened to mount it first.
 */
export function ChatShellLayout() {
  const keyboard = useKeyboardInset();
  const wide = useWideLayout();
  const listWidth = useSettingsStore((state) => state.listWidth);
  const location = useLocation();

  // ADR 0080: remembers which Destination the reader is standing on, for
  // `/`'s own Continue card at the wide breakpoint — mounted here, rather
  // than in any one Destination's own page, because this layout is what
  // persists across every route change (`/` included), where a per-page
  // effect would already have unmounted by the time the reader reached `/`.
  // `destinationForPath` returns `null` for `/` itself, so a bare visit to
  // the root screen is never recorded as the Destination to continue into.
  useEffect(() => {
    const destination = destinationForPath(location.pathname);
    if (destination !== null) {
      writeLastDestination(destination);
    }
  }, [location.pathname]);

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
            {/*
              The owner overruled ADR 0076: this pane is always
              `ChatListPane` now, `/todo/*` included, rather than swapping
              in `TodoSidebar` on a Todo route. `TodoSidebar` still
              renders on `/todo/*`, but as a second column inside Todo's own
              subtree above 1200px (`todo-page.tsx`'s own header comment)
              rather than replacing the pane that already exists — entering
              Todo no longer makes the rest of the app disappear.
            */}
            <ChatListPane />
          </div>
          <PaneDivider />
        </>
      )}
      <Outlet />
    </div>
  );
}
