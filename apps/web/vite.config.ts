/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client only ever uses relative URLs (e.g. `/v1/sync`) and never learns
// its own host — this proxy is what makes that possible in dev, and is also
// what keeps CORS configuration off the Rust server entirely.
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
    resolve: {
      alias: [
        {
          find: "@/platform/wake-signals",
          replacement: path.resolve(
            import.meta.dirname,
            `./src/platform/wake-signals.${target}.ts`,
          ),
        },
        { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      ],
    },
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
