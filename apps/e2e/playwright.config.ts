import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { SERVER_A_PORT, SERVER_A_URL, SERVER_B_PORT, SERVER_B_URL } from "./servers";
import { serverUrlStorageState } from "./tests/helpers";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: SERVER_A_URL,
    trace: "retain-on-failure",
    // Sync is opt-in (ADR 0011): every context needs a Server URL seeded
    // before its first page load, or it starts with sync off. This is the
    // default context/page fixture's seed — openTwoDevices (tests/helpers.ts)
    // seeds each BrowserContext it creates the same way, since those are
    // opened manually rather than through this fixture.
    storageState: serverUrlStorageState(SERVER_A_URL),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Two fully independent Servers, each against its own Postgres (ADR 0011):
  // server A is the production serving path from ticket 11 — it also builds
  // and serves the web app — and server B exists only to prove a Device's
  // Entries follow its own Server URL setting, never the origin that served
  // its page. Playwright starts both and waits for each to answer its own
  // readiness URL before running any test.
  webServer: [
    {
      command: "bash scripts/e2e-server.sh",
      cwd: repoRoot,
      env: { PORT: String(SERVER_A_PORT) },
      url: SERVER_A_URL,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "bash scripts/e2e-server-b.sh",
      cwd: repoRoot,
      env: { PORT: String(SERVER_B_PORT) },
      // /v1/health rather than the origin root: server B never serves the
      // SPA (ADR 0010 — the health endpoint touches nothing else), so it
      // doesn't need to wait on server A's web build to be ready.
      url: `${SERVER_B_URL}/v1/health`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
