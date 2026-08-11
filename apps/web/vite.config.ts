/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client only ever uses relative URLs (e.g. `/v1/sync`) and never learns
// its own host — this proxy is what makes that possible in dev, and is also
// what keeps CORS configuration off the Rust server entirely.
const SERVER_PROXY_TARGET = "http://localhost:41207";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
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
});
