import type { CapacitorConfig } from "@capacitor/cli";

// The Android shell (ticket 14) needs an `http` scheme rather than Capacitor's
// `https` default: an `http://localhost` origin can reach both `http://` and
// `https://` servers, so it never needs revisiting — and because IndexedDB and
// localStorage are keyed to the webview's origin, changing the scheme later
// would orphan every Entry already stored under it.
const config: CapacitorConfig = {
  appId: "com.meologue.app",
  appName: "meologue",
  webDir: "dist",
  server: {
    androidScheme: "http",
  },
};

export default config;
