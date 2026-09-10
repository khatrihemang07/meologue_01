import { type CSSProperties, lazy, Suspense } from "react";
import { Outlet, useLocation } from "react-router";
import { ChatListPane } from "@/components/chat-list-pane";
import { PaneDivider } from "@/components/pane-divider";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { useSettingsStore } from "@/lib/settings";

// Lazy, exactly like `todo-page.tsx`/`settings-page.tsx` themselves
// (App.tsx's own header comment on issue #150's cold-start boundary) —
// this component renders unconditionally on every route, `/` included, so
// a static import here would drag `entry-store-layout.tsx` (todo-sidebar.tsx's
// own header comment explains why it needs that module) onto the one path
// that boundary exists to keep clear, for a reader who may never open Todo
// at all. `Suspense fallback={null}` below reuses App.tsx's own reasoning
// for its outer boundary: every lazy chunk here ships in the same install
// as the shell, so a frame or two of nothing beats a flash of chrome
// nobody has time to read.
const TodoSidebar = lazy(() =>
  import("@/components/todo/todo-sidebar").then((m) => ({ default: m.TodoSidebar })),
);

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
 * `data-surface="todo"` (issue #223's first half) is set here rather than
 * inside `TodoPage` itself, precisely because this element is also the one
 * ancestor the left pane sits under — `ChatListPane` above renders inside
 * this same div, outside `Shell`. Todo's own sidebar (#223's second half)
 * replaces what that pane shows while a `/todo/*` route is open, and it
 * needs the identical Todoist palette the page itself gets; one attribute
 * up here covers both without a second scope lower down. `useLocation`
 * rather than reading `window.location` directly is what keeps this
 * re-rendering on every route change rather than only on remount — this
 * layout persists across navigation (it wraps every Destination via one
 * `<Route element={<ChatShellLayout />}>` in App.tsx), so a plain read at
 * mount would freeze the attribute at whatever Destination first mounted
 * it in. The attribute is omitted, not set empty, when it doesn't apply:
 * index.css's `[data-surface="todo"]` selector matches an empty string
 * value too, so leaving it out entirely is what actually keeps every
 * non-Todo Destination unscoped.
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

  return (
    <div
      className="flex h-[calc(100svh-var(--keyboard-inset))] w-full overflow-hidden bg-background [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]"
      data-surface={isTodo ? "todo" : undefined}
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
              The existing pane, reused rather than duplicated (issue
              #223's own brief: no second pane, no second divider, no
              second width mechanism) — `TodoSidebar` replaces
              `ChatListPane`'s content precisely while `isTodo` is true,
              the same boolean this file's own `data-surface` line already
              computed for the identical route test. `Suspense
              fallback={null}` only ever matters on the first `/todo/*`
              navigation in a session; every navigation after that hits an
              already-resolved module.
            */}
            {isTodo ? (
              <Suspense fallback={null}>
                <TodoSidebar />
              </Suspense>
            ) : (
              <ChatListPane />
            )}
          </div>
          <PaneDivider />
        </>
      )}
      <Outlet />
    </div>
  );
}
