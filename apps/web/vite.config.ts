/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// A Device only ever talks to the address typed into Settings (ADR 0011),
// never an implicit one — including in dev. Pointing the Server URL at this
// dev origin (e.g. http://localhost:5173) routes /v1/* through this proxy
// to the real server on :41207. The server still needs CORS (ticket 13)
// because a built app running inside Capacitor or Tauri has no origin to
// share with the server at all. MEOLOGUE_PROXY_TARGET overrides this for a
// hot-reload session aimed at the sandbox target's server on a different
// port instead, without editing this file.
const SERVER_PROXY_TARGET = process.env.MEOLOGUE_PROXY_TARGET ?? "http://localhost:41207";

// The build-time platform seam (ticket 12): one Vite application whose
// per-target files (e.g. `src/platform/wake-signals.<target>.ts`) are
// selected here, via `--mode <target>`, rather than branched at runtime —
// so a target's build never bundles another target's platform code. Any
// mode outside this set (e.g. vitest's "test", or an unqualified
// `vite build`'s "production") falls back to "web", so existing scripts and
// the web build stay unchanged in behaviour. "sandbox" is a fourth,
// browser-based target for an isolated testing instance, served by its own
// server on its own port so a build for it can never overwrite the bundle
// the user's own server serves.
const BUILD_TARGETS = ["web", "android", "macos", "sandbox"];

export default defineConfig(({ mode }) => {
  const target = BUILD_TARGETS.includes(mode) ? mode : "web";

  return {
    plugins: [
      react(),
      tailwindcss(),
      // Only the web target gets a service worker (ticket 45): Android and
      // macOS run inside WebViews, not a browser, and a service worker
      // there would register against a scope no browser chrome ever shows
      // an install prompt or an update for — ADR 0005's build-time seam is
      // what makes "web" a value this file can just check, rather than a
      // runtime guess. `target === "web"` is deliberately not
      // `target !== "android" && target !== "macos"`: sandbox is that
      // fourth target, and correctly gets no service worker here without
      // this having to be revisited; any further target not yet added to
      // BUILD_TARGETS above defaults to "web" and should not silently
      // inherit one either, without that being decided here.
      target === "web" &&
        VitePWA({
          // "sw.js" and "manifest.webmanifest" are this plugin's own
          // defaults, kept explicit here because server/src/lib.rs's
          // set_static_cache_control (ticket 44) has to name them too —
          // changing either without updating that function pins Devices to
          // a stale app forever, since neither file would ever get the
          // "no-cache" header a deploy needs to be noticed.
          filename: "sw.js",
          manifestFilename: "manifest.webmanifest",
          strategies: "generateSW",
          // The composer may hold a half-typed Entry when a new version
          // deploys — "autoUpdate" would reload out from under the user and
          // discard it. "prompt" hands control to registerServiceWorker
          // (@/platform/register-service-worker), which shows a sonner
          // toast offering to reload instead.
          registerType: "prompt",
          // Registration is called explicitly from main.tsx via the
          // register-service-worker platform seam, not injected as a
          // separate script — "auto" would otherwise detect that call and
          // do nothing, but saying so outright is clearer than relying on
          // detection.
          injectRegister: false,
          devOptions: {
            // A service worker in dev is a debugging trap: it would cache
            // Vite's dev server responses and survive across restarts,
            // masking exactly the kind of change dev mode exists to show
            // immediately.
            enabled: false,
          },
          manifest: {
            name: "meologue",
            short_name: "meologue",
            start_url: "/",
            display: "standalone",
            // Matches index.html's pre-paint theme script and
            // src/lib/theme.ts's dark palette — the install prompt and the
            // OS task switcher should never flash a colour the app itself
            // never shows.
            theme_color: "#18181B",
            background_color: "#18181B",
            icons: [
              { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
              { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
              {
                src: "/icon-512-maskable.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "maskable",
              },
            ],
          },
          workbox: {
            // @sqlite.org/sqlite-wasm's binary is over a megabyte — above
            // workbox's default 2 MiB cap only once source maps and the
            // rest of the bundle are counted alongside it, and the default
            // behaviour on exceeding it is to silently drop the file from
            // the precache rather than fail the build. An app that installs,
            // looks fine, and then can't open its store offline is worse
            // than a slightly stale cap; 10 MiB leaves headroom for the
            // wasm binary to grow before this needs revisiting.
            maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
            // A sync request must never be answered by the app shell: the
            // default navigateFallback ("index.html") exists so client-side
            // routes like /history resolve offline, but without this
            // denylist it would also catch a request under /v1/* and hand
            // back HTML where the caller expects JSON, turning a clean
            // network failure into a JSON parse error.
            navigateFallbackDenylist: [/^\/v1\//],
            // Belt and braces alongside the denylist above: even if a
            // /v1/* request were ever handled by this service worker for
            // some other reason, NetworkOnly guarantees it is never
            // answered from a cache.
            runtimeCaching: [
              {
                urlPattern: /^\/v1\//,
                handler: "NetworkOnly",
              },
            ],
          },
        }),
    ],
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
        {
          find: "@/platform/save-file",
          replacement: path.resolve(import.meta.dirname, `./src/platform/save-file.${target}.ts`),
        },
        {
          find: "@/platform/register-service-worker",
          replacement: path.resolve(
            import.meta.dirname,
            `./src/platform/register-service-worker.${target}.ts`,
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
