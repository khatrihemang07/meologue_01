import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { ComposerPage } from "@/pages/composer-page";
import { EntryStoreLayout } from "@/pages/entry-store-layout";
import { HistoryPage } from "@/pages/history-page";
import { SettingsPage } from "@/pages/settings-page";

// Real paths, not hash routing (ticket 25) — verified safe on all three
// targets: the Rust server's ServeDir falls back to index.html for unknown
// paths, Capacitor's html5mode defaults to on, and Tauri 2.11's asset
// resolution falls back to the app shell the same way. No route segment
// below may ever contain a "." — Capacitor's fallback check treats a dot in
// the last path segment as a request for a real file, not the app shell.
//
// EntryStoreLayout wraps only `/` and `/history` (ticket 27): both read the
// Entry store and History through it, opened and synced exactly once.
// Settings is a sibling, not a child of that layout — ADR 0008 requires it
// to stay usable even when the store never reaches "ready".
function App() {
  return (
    <BrowserRouter>
      <Toaster />
      <Routes>
        <Route element={<EntryStoreLayout />}>
          <Route path="/" element={<ComposerPage />} />
          <Route path="/history" element={<HistoryPage />} />
        </Route>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
