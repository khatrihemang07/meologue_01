import { BrowserRouter, Route, Routes } from "react-router";
import { HistoryPage } from "@/pages/history-page";
import { SettingsPage } from "@/pages/settings-page";

// Real paths, not hash routing (ticket 25) — verified safe on all three
// targets: the Rust server's ServeDir falls back to index.html for unknown
// paths, Capacitor's html5mode defaults to on, and Tauri 2.11's asset
// resolution falls back to the app shell the same way. No route segment
// below may ever contain a "." — Capacitor's fallback check treats a dot in
// the last path segment as a request for a real file, not the app shell.
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
