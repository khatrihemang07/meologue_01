import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { ChatListPage } from "@/pages/chat-list-page";
import { ChatShellLayout } from "@/pages/chat-shell-layout";

// Issue #150's lazy boundary: `/` (ChatListPage, above) is the one screen a
// cold start always renders, and it "renders whether or not the store ever
// opens" per this file's own comment below — it never touches
// EntryStoreLayout or `@meologue/core`. Every route past it, and the layout
// that opens the store for three of them, is dynamic `import()` instead of
// a static one, so none of that weight — `@meologue/core`'s `open()`, the
// sqlite driver, and each page's own code — sits on the WebView's
// cold-start parse-and-eval path (Android has no service worker to have
// already cached it in the background the way the web target's does). A
// document editor landing at ~69 KB gzip (issue #155) is exactly the kind
// of weight this boundary exists to keep off that path, by construction
// rather than by remembering to split it later.
const EntryStoreLayout = lazy(() =>
  import("@/pages/entry-store-layout").then((m) => ({ default: m.EntryStoreLayout })),
);
const ComposerPage = lazy(() =>
  import("@/pages/composer-page").then((m) => ({ default: m.ComposerPage })),
);
const ReflectionPage = lazy(() =>
  import("@/pages/reflection-page").then((m) => ({ default: m.ReflectionPage })),
);
const SessionsPage = lazy(() =>
  import("@/pages/sessions-page").then((m) => ({ default: m.SessionsPage })),
);
const DigestPage = lazy(() =>
  import("@/pages/digest-page").then((m) => ({ default: m.DigestPage })),
);
const DigestReaderPage = lazy(() =>
  import("@/pages/digest-reader-page").then((m) => ({ default: m.DigestReaderPage })),
);
const TodoPage = lazy(() => import("@/pages/todo-page").then((m) => ({ default: m.TodoPage })));
const SettingsPage = lazy(() =>
  import("@/pages/settings-page").then((m) => ({ default: m.SettingsPage })),
);

// Real paths, not hash routing (ticket 25) — verified safe on all three
// targets: the Rust server's ServeDir falls back to index.html for unknown
// paths, Capacitor's html5mode defaults to on, and Tauri 2.11's asset
// resolution falls back to the app shell the same way. No route segment
// below may ever contain a "." — Capacitor's fallback check treats a dot in
// the last path segment as a request for a real file, not the app shell.
// `/todo`, `/todo/inbox` (issue #168), `/todo/today` (issue #169) and
// `/todo/projects` (issue #171) are all static literal segments, trivially
// safe under that rule the same obvious way `/composer` already is —
// `/todo/projects/:projectId` (issue #171) is not, and carries the
// identical argument `/reflect/:sessionId` and `/digest/:period/:date`
// just below already do for why their own dynamic segment is still safe
// (a Device-minted uuid never contains a ".").
//
// EntryStoreLayout wraps `/`, `/reflect`, `/digest`, `/todo`,
// `/todo/inbox`, `/todo/today`, `/todo/projects` and
// `/todo/projects/:projectId` (ticket 27, extended by ADR 0020, issue
// #71, issue #168, issue #169 and issue #171; briefly narrowed by issue
// #75, which deleted `/history` outright — no
// redirect, since the Composer at `/` already renders the identical History
// component with the identical props, and a second door onto the same room
// added nothing this layout needed to keep open). All of them read the
// Entry store, and now the Task store (ADR 0047), through it, opened and
// synced exactly once. Digest is the odd one out among them —
// CONTEXT.md's Digest entry is explicit that it lives only on the Server,
// so this page reads no Entry directly the way Composer/Reflect/Todo do —
// but it still belongs inside this layout rather than beside it, because
// the layout is what drives Sync: a reader parked on `/digest` must not
// stop syncing just because that page itself never touches an Entry.
//
// Settings is a sibling, not a child of that layout — ADR 0008/0009 require
// it to stay usable and reachable even when the store never reaches
// "ready", since a bad Server URL is what gets fixed there. That guarantee
// is structural, not incidental to how Settings happens to be reached: it
// held when Settings was an app-bar action on every page (ADR 0018-0020),
// and issue #75 moving Settings into the persistent Nav instead (see
// nav.tsx's DESTINATIONS) changes *how* a reader gets to `/settings`, not
// *what* `/settings` depends on — so this route stays right where it was.
function App() {
  return (
    <BrowserRouter>
      <Toaster />
      {/* A blank fallback, not a spinner: ChatShellLayout's own root div
          already paints `bg-background` behind the Outlet (see that
          component), so a lazy chunk that resolves in a frame or two — the
          only case that matters, since every chunk ships in the same
          install as the shell rather than over a slow network — shows
          nothing rather than a flash of chrome the reader never has time to
          read. One boundary around the whole route tree, not one per route,
          because ChatListPage never suspends and every route past it is
          equally fine sharing it. */}
      <Suspense fallback={null}>
        <Routes>
          {/* ADR 0036: every route renders inside the chat shell, which owns
              the window, the keyboard custom properties, and — at 900px and
              up — the chat list pinned beside whatever is open. It reads no
              Entry and no Server, so wrapping `/settings` in it costs that
              route none of the independence ADR 0008/0009 require. */}
          <Route element={<ChatShellLayout />}>
            {/* `/` is the root screen, and it is not the Composer any more:
                a list of five rows you navigate away from (ADR 0036),
                superseding ADR 0030's persistent nav in its strongest form —
                issue #168's Todo row is the fifth, ADR 0049 is the argument
                for why its own internal navigation doesn't reopen ADR 0036.
                It sits outside EntryStoreLayout deliberately — the list names
                destinations rather than reading any of them, so it renders
                whether or not the store ever opens, the same guarantee
                `/settings` has always had. */}
            <Route path="/" element={<ChatListPage />} />
            <Route element={<EntryStoreLayout />}>
              <Route path="/composer" element={<ComposerPage />} />
              {/* `/reflect` is a fresh Session; `/reflect/:sessionId` is an open
              one (ADR 0025). Session ids are uuids, so they never contain a
              "." and stay safe under the constraint above — but flagging
              that here so nobody later routes something dotted into this
              segment. `/reflect/list` (ticket 62) is the Sessions screen
              reached from Reflection's app bar — a static segment, so
              react-router ranks it above `:sessionId` regardless of
              declaration order, and no Session id can ever collide with the
              literal word "list". */}
              <Route path="/reflect" element={<ReflectionPage />} />
              <Route path="/reflect/list" element={<SessionsPage />} />
              <Route path="/reflect/:sessionId" element={<ReflectionPage />} />
              {/* `/digest` is the third nav destination's cards (issue #71,
              renumbered from fourth to third by issue #75 dropping History);
              `/digest/:period/:date` opens one of them. `period` is always
              "day"/"week"/"month" and `date` is a `YYYY-MM-DD`
              `period_start` (server/src/digest.rs) — like a Session id,
              neither ever contains a "." and stays safe under the
              constraint above, but flagging that here for the same reason
              ADR 0020 flagged it for Session ids: so nobody later routes
              something dotted into either segment. */}
              <Route path="/digest" element={<DigestPage />} />
              <Route path="/digest/:period/:date" element={<DigestReaderPage />} />
              {/* Todo (issue #168): `/todo` itself redirects rather than
              rendering anything of its own, so a bookmark or a reload of the
              bare Destination lands somewhere real — the same reason
              `/reflect` (a fresh Session) needed no redirect but a bare
              `/todo` does, since Todo has no "fresh, undirected" view the
              way a new Session is. `/todo/inbox` is the one view issue #168
              added; `/todo/today` (issue #169) and `/todo/projects`/
              `/todo/projects/:projectId` (issue #171) are exactly the
              sibling routes ADR 0049 named in advance — one more `<Route>`
              line apiece, all pointing at the same lazily-imported
              `TodoPage` (`todo-page.tsx`'s own doc comment on its `view`
              prop explains why that's one dynamic chunk, not four) rather
              than four separately-imported page components. `projectId` is
              a Device-minted uuid (`mintId()`, `@meologue/core`), never
              containing a "." for the identical reason a Session id or a
              Digest `date` never does — flagged here for the same reason
              those two routes' own comments flag it, so nobody later routes
              something dotted into this segment. */}
              <Route path="/todo" element={<Navigate to="/todo/inbox" replace />} />
              <Route path="/todo/inbox" element={<TodoPage />} />
              <Route path="/todo/today" element={<TodoPage view="today" />} />
              <Route path="/todo/projects" element={<TodoPage view="projects" />} />
              <Route path="/todo/projects/:projectId" element={<TodoPage view="project" />} />
              {/* The full search page (issue #183) — Quick-find's
              (task-quick-find.tsx) "Show more results" own destination, and
              its own linkable, bookmarkable URL, `?q=` and the rest carried
              as ordinary search params rather than a route segment (the
              same shape use-history-search.ts's own `q` param already
              takes) — no dynamic segment here, so this stays a plain
              static literal, safe under this file's own no-dot rule
              trivially. */}
              <Route path="/todo/search" element={<TodoPage view="search" />} />
              {/* Todo's activity log (issue #184, ADR 0056) — the view
              across everything; a Project's own history is the same route
              opened with `?projectId=` (project-view.tsx's own "Activity"
              link), the identical "ordinary search params, not a route
              segment" shape `/todo/search`'s own comment above already
              takes for `?q=`. */}
              <Route path="/todo/activity" element={<TodoPage view="activity" />} />
              {/* A Task's own address (issue #178), still under `/todo/*` per
              ADR 0049's own constraint on where Todo's internal navigation
              may live — no `view` prop: `todo-page.tsx`'s own header
              comment on `taskSlugId` explains how it recovers *which*
              background view (Inbox/Today/a Project) to render dimmed
              behind the Task's own modal/sheet from `location.state`
              rather than from a prop this route would otherwise have to
              guess at. `taskSlugId` is `<slug>-<id>`
              (lib/task-detail-route.ts) — the trailing id is a `mintId()`
              uuid, so, like every dynamic segment above, it never
              contains a "." and stays safe under this file's own
              no-dot-in-a-`/todo/*`-segment rule; the slug half is
              stripped of everything but `[a-z0-9-]` by the same module,
              for the identical reason. */}
              <Route path="/todo/task/:taskSlugId" element={<TodoPage />} />
            </Route>
            {/* A sibling of EntryStoreLayout's children above, not nested under
              it — see this file's own top comment for why that has to hold
              regardless of where Settings sits in the Nav. */}
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
