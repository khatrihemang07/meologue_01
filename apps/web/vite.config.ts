/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// With VITE_SERVER_URL unset (its default — see ADR 0006), the client uses
// relative URLs (e.g. `/v1/sync`) and never learns its own host; this proxy
// is what makes that work in dev, standing in for same-origin production
// serving (ticket 11). The server still needs CORS (ticket 13) because a
// built app running inside Capacitor or Tauri has no such origin to share.
const SERVER_PROXY_TARGET = "http://localhost:41207";

// The build-time platform seam (ticket 12): one Vite application whose
// per-target files (e.g. `src/platform/wake-signals.<target>.ts`) are
// selected here, via `--mode <target>`, rather than branched at runtime —
// so a target's build never bundles another target's platform code. Any
// mode outside this set (e.g. vitest's "test", or an unqualified
// `vite build`'s "production") falls back to "web", so existing scripts and
// the web build stay unchanged in behaviour.
const BUILD_TARGETS = ["web", "android", "macos"];

export default defineConfig(({ mode }) => {
  const target = BUILD_TARGETS.includes(mode) ? mode : "web";

  return {
    plugins: [react(), tailwindcss()],
    // Nested under the same `target` used for the platform-file alias above,
    // so each target's bundle lands in its own directory and a build for one
    // target can never overwrite another's (ticket 17).
    build: { outDir: `dist/${target}` },
    resolve: {
      alias: [
        {
          find: "@/platform/wake-signals",
          replacement: path.resolve(
            import.meta.dirname,
            `./src/platform/wake-signals.${target}.ts`,
          ),
        },
        {
          find: "@/platform/sqlite-driver",
          replacement: path.resolve(
            import.meta.dirname,
            `./src/platform/sqlite-driver.${target}.ts`,
          ),
        },
        { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      ],
    },
    // sqlite-worker.web.ts (only ever reachable from sqlite-driver.web.ts) uses a
    // static `import`; Vite's default worker output format (iife) can't contain
    // one, so module workers need this set explicitly.
    worker: { format: "es" },
    // @sqlite.org/sqlite-wasm's own wasm loader doesn't survive Vite's dev-time
    // dependency pre-bundling (its docs call this out for the worker usage).
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
    server: {
      proxy: {
        "/v1": SERVER_PROXY_TARGET,
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});
