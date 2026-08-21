import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { ComposerPage } from "@/pages/composer-page";
import { DigestPage } from "@/pages/digest-page";
import { DigestReaderPage } from "@/pages/digest-reader-page";
import { EntryStoreLayout } from "@/pages/entry-store-layout";
import { HistoryPage } from "@/pages/history-page";
import { ReflectionPage } from "@/pages/reflection-page";
import { SessionsPage } from "@/pages/sessions-page";
import { SettingsPage } from "@/pages/settings-page";

// Real paths, not hash routing (ticket 25) — verified safe on all three
// targets: the Rust server's ServeDir falls back to index.html for unknown
// paths, Capacitor's html5mode defaults to on, and Tauri 2.11's asset
// resolution falls back to the app shell the same way. No route segment
// below may ever contain a "." — Capacitor's fallback check treats a dot in
// the last path segment as a request for a real file, not the app shell.
//
// EntryStoreLayout wraps `/`, `/history`, `/reflect` and `/digest` (ticket
// 27, extended by ADR 0020 and issue #71): all four read the Entry store
// and History through it, opened and synced exactly once. Digest is the odd
// one out among the four — CONTEXT.md's Digest entry is explicit that it
// lives only on the Server, so this page reads no Entry directly the way
// Composer/History/Reflect do — but it still belongs inside this layout
// rather than beside it, because the layout is what drives Sync: a reader
// parked on `/digest` must not stop syncing just because that page itself
// never touches an Entry. Settings is a sibling, not a child of that layout
// — ADR 0008 requires it to stay usable even when the store never reaches
// "ready".
function App() {
  return (
    <BrowserRouter>
      <Toaster />
      <Routes>
        <Route element={<EntryStoreLayout />}>
          <Route path="/" element={<ComposerPage />} />
          <Route path="/history" element={<HistoryPage />} />
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
          {/* `/digest` is the fourth nav destination's cards (issue #71);
              `/digest/:period/:date` opens one of them. `period` is always
              "day"/"week"/"month" and `date` is a `YYYY-MM-DD`
              `period_start` (server/src/digest.rs) — like a Session id,
              neither ever contains a "." and stays safe under the
              constraint above, but flagging that here for the same reason
              ADR 0020 flagged it for Session ids: so nobody later routes
              something dotted into either segment. */}
          <Route path="/digest" element={<DigestPage />} />
          <Route path="/digest/:period/:date" element={<DigestReaderPage />} />
        </Route>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
