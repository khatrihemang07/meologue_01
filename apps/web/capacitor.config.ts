import type { CapacitorConfig } from "@capacitor/cli";

// The Android shell (ticket 14) needs an `http` scheme rather than Capacitor's
// `https` default: an `http://localhost` origin can reach both `http://` and
// `https://` servers, so it never needs revisiting — and because IndexedDB and
// localStorage are keyed to the webview's origin, changing the scheme later
// would orphan every Entry already stored under it.
const config: CapacitorConfig = {
  appId: "com.meologue.app",
  appName: "meologue",
  webDir: "dist/android",
  server: {
    androidScheme: "http",
  },
  // The Android shell is a sibling app directory, not a child of the web app:
  // `apps/android` alongside `apps/macos`. Capacitor would otherwise generate
  // `android/` next to this config file. This config stays here because it
  // describes how the web app is packaged, and keeping it here is what lets
  // `apps/android` hold the native project alone — no second package.json and
  // no duplicated Capacitor dependencies.
  android: {
    path: "../android",
  },
};

export default config;
