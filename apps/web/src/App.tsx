import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { ComposerPage } from "@/pages/composer-page";
import { EntryStoreLayout } from "@/pages/entry-store-layout";
import { HistoryPage } from "@/pages/history-page";
import { ReflectionPage } from "@/pages/reflection-page";
import { SettingsPage } from "@/pages/settings-page";

// Real paths, not hash routing (ticket 25) — verified safe on all three
// targets: the Rust server's ServeDir falls back to index.html for unknown
// paths, Capacitor's html5mode defaults to on, and Tauri 2.11's asset
// resolution falls back to the app shell the same way. No route segment
// below may ever contain a "." — Capacitor's fallback check treats a dot in
// the last path segment as a request for a real file, not the app shell.
//
// EntryStoreLayout wraps `/`, `/history` and `/reflect` (ticket 27, extended
// by ADR 0020): all three read the Entry store and History through it,
// opened and synced exactly once. Reflect only ever reads Entries
// (CONTEXT.md), same as History, which is why it belongs inside this layout
// rather than beside it. Settings is a sibling, not a child of that layout —
// ADR 0008 requires it to stay usable even when the store never reaches
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
              segment. */}
          <Route path="/reflect" element={<ReflectionPage />} />
          <Route path="/reflect/:sessionId" element={<ReflectionPage />} />
        </Route>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
