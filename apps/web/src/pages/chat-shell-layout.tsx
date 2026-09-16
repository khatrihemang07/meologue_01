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
import { useTodoSurface } from "@/lib/todo-surface";

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
 * `data-surface="todo"` (issue #223) is written onto **`documentElement`**,
 * not onto this component's own div, and that placement is the whole of what
 * makes the token scope actually hold. The write itself now lives in
 * `lib/todo-surface.ts`; this file holds the *route's* claim on it, and is no
 * longer the only claimant — see that module's header for why they are counted.
 *
 * It began on the div, which is the ancestor both the left pane and the open
 * Destination share, and that looked sufficient. It was not. Radix renders
 * every overlay through a Portal into `document.body` — the task detail
 * dialog, the command menu, quick-find, the sheets, the confirm dialogs and
 * the scheduler popover all land **outside** this subtree. A scope on the
 * div therefore never reached any of them: measured live, the detail dialog
 * came back `insideScope: false`, painted `oklch(0.205 0 0)` from the app's
 * own palette instead of Todoist's ground, and still set in Geist. It had
 * rendered unthemed since the scope landed, and no test could see it,
 * because jsdom has no layout and the class names were all present and
 * correct.
 *
 * Patching each overlay to re-declare the attribute would work exactly until
 * the next overlay someone adds forgets to. `documentElement` is above every
 * portal by construction, so nothing can escape it, and it is where this app
 * already keeps its other whole-document switches — `lib/theme.ts` writes
 * `data-accent`, `data-text-size` and `data-completed-style` onto the same
 * element for the same reason.
 *
 * **The route is not the same question as "is a Todo surface on screen", and
 * conflating the two was a real defect.** The Composer's Task detail overlay
 * (ADR 0074, `composer-page.tsx`) is the real `TaskDetailView` rendered over
 * `/composer`, where `isTodo` below is correctly false — so every `--td-*`
 * token resolved to nothing underneath it. Measured on the device: on
 * `/composer`, `--td-recognition-background`, `--td-priority-picker-1` and
 * `--td-composer-background` all read `(UNSET)`. That is why a recognised date
 * painted no chip there and the priority swatches all rendered grey. The
 * overlay now holds its own claim.
 *
 * Scoping the whole document was safe under ADR 0076 because of what a
 * `/todo/*` route rendered: the pane showed Todo's own sidebar and the
 * Outlet showed Todo, so there was no non-Todo surface on screen to repaint
 * by accident. **That is no longer true.** The owner overruled ADR 0076: this
 * pane is always `ChatListPane`, `/todo/*` included, so `ChatListPane` now
 * renders inside the `data-surface="todo"` scope and repaints in Todoist's
 * palette while Todo is open, alongside the app's own — an accepted visual
 * consequence of the amendment, not one this file tries to undo; scoping the
 * token write itself is `todo-surface.ts`'s concern, unchanged here. The
 * overlay's own claim is still safe for the narrower reason it always was:
 * it is modal, so while it is open it *is* the surface the reader is
 * looking at.
 *
 * `useLocation` rather than reading `window.location` keeps this reacting to
 * every route change rather than only to a remount — this layout persists
 * across navigation, so a plain read at mount would freeze the attribute at
 * whichever Destination happened to mount it first.
 */
export function ChatShellLayout() {
  const keyboard = useKeyboardInset();
  const wide = useWideLayout();
  const listWidth = useSettingsStore((state) => state.listWidth);
  const location = useLocation();
  // The exact-or-slash test rather than a bare prefix: `startsWith("/todo")`
  // would also scope a future `/todoist` or `/todo-archive` route, and a
  // Destination silently repainting itself in another Destination's palette
  // is the kind of defect nobody looks for because nobody caused it.
  const isTodo = location.pathname === "/todo" || location.pathname.startsWith("/todo/");

  // The route's own claim on the Todo token scope. It is no longer the only
  // one: `composer-page.tsx` holds a second while its Task detail overlay is
  // open, because that overlay is the real `TaskDetailView` rendered over
  // `/composer`, where this test correctly says "not Todo" and would otherwise
  // strip every `--td-*` token out from under it. `todo-surface.ts`'s own
  // header comment has the measurement and the reason the claims are counted
  // rather than written directly.
  useTodoSurface(isTodo);

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
              in `TodoSidebar` while `isTodo` is true. `TodoSidebar` still
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
