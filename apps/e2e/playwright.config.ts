import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// A dedicated port, distinct from the :41207 a developer's own `cargo run`
// might already be using — the e2e run gets its own server instance.
const PORT = 41217;
export const BASE_URL = `http://localhost:${PORT}`;

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Builds the web app and boots the real Rust server against real Postgres —
  // this is the production serving path from ticket 11, exercised for real
  // rather than mocked, since that's what the acceptance test is meant to prove.
  webServer: {
    command: "bash scripts/e2e-server.sh",
    cwd: repoRoot,
    env: { PORT: String(PORT) },
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
