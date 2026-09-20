import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  LLM_STUB_PORT,
  LLM_STUB_URL,
  SERVER_A_PORT,
  SERVER_A_URL,
  SERVER_B_PORT,
  SERVER_B_URL,
} from "./servers";
import { serverUrlStorageState } from "./tests/helpers";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  // Issue #190: `fullyParallel: false` only keeps ONE file's own tests from
  // running concurrently with each other — nothing above previously stopped
  // Playwright's default worker count (half the machine's CPU cores) from
  // handing two DIFFERENT spec files to two different worker processes at
  // once, both hitting server A's one shared, stateful database at the same
  // time. Every spec in this suite is already written on the assumption
  // that it runs sequentially against one shared Server (todo.spec.ts's own
  // header comment predates this line), and `tests/fixtures.ts`'s own
  // `resetServer` fixture depends on "before every test" being a
  // well-defined moment — neither is true unless there is only one worker.
  // The cost is real (the suite no longer gets any file-level parallelism),
  // but a suite that was quietly racing two Node processes against the same
  // Postgres database was never the sequential suite every spec's own
  // comments already assumed it to be.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Issue #112: the per-test default (30s) is tight once a test's own body
  // does real polling for Server-side background work (tests/helpers.ts's
  // `waitForEmbedding`/`waitForTombstone`) on top of the usual UI
  // assertions — on a loaded machine that polling alone can eat well into
  // 30s, leaving the rest of the test no room. Raised suite-wide for the
  // same reason `expect.timeout` below is: this suite's own webServer
  // array is heavy enough that a quiet-machine budget isn't a safe default.
  timeout: 60_000,
  // Issue #112: with no `expect` block, every implicit `expect(...).toBeVisible()`
  // (etc.) across the suite falls back to Playwright's own default of 5000ms —
  // plenty on a quiet machine, but this suite's webServer array below spawns two
  // real Rust servers, a Postgres container and a Node stub, all fighting for CPU
  // with whatever else is running. The issue's own quoted failure is exactly this:
  // a `getByText(...).toBeVisible()` with no explicit timeout, timing out at
  // 5000ms under load. Raised suite-wide rather than patched call-by-call, since
  // the same default sits behind assertions this pass didn't individually audit.
  expect: { timeout: 15_000 },
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
  projects: [
    // `testIgnore` keeps composer-touch.spec.ts (below) off this project:
    // with no filter of its own, "chromium" would otherwise pick it up too
    // — Playwright's default per-project `testMatch` is "everything in
    // `testDir`" — and run its touch-only assertions (indent/outdent/
    // soft-break present, code absent) against a genuinely hover-capable
    // Desktop Chrome, where they'd fail for having nothing to do with a
    // real defect.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /composer-touch\.spec\.ts/,
    },
    // Issue #213: the only browser coverage that can actually see a touch
    // device. `page.emulateMedia()` (used elsewhere in this suite) covers
    // media/colorScheme/reducedMotion/forcedColors/contrast — NOT `hover`,
    // so there is no way to make the default "chromium" project itself
    // report `(hover: none)`. `devices["Pixel 7"]`'s `isMobile: true` is
    // what does that — Chromium reports no-hover for a mobile UA, not
    // merely for `hasTouch` — which a plain `{ hasTouch: true }` override on
    // the desktop project would not have triggered.
    //
    // `testMatch` scopes this to the specs that carry touch-only behavior,
    // deliberately: Composer's touch toolbar and Quick Add's FAB/sheet/
    // stay-open submit branch. The latter also carries desktop cases, but
    // skips those cases in this project and runs only its touch describe.
    // `workers: 1, fullyParallel: false` above exist because this suite
    // shares one Postgres across every test (this config's own comment on
    // `workers`), and an unscoped second project would run the ENTIRE
    // existing suite a second time against that same database, doubling
    // both the runtime and the two Rust servers/Postgres container already
    // booted for it.
    {
      name: "chromium-touch",
      use: { ...devices["Pixel 7"] },
      testMatch: /(composer-touch|quick-add-parity)\.spec\.ts/,
    },
  ],
  // Two fully independent Servers, each against its own Postgres (ADR 0011):
  // server A is the production serving path from ticket 11 — it also builds
  // and serves the web app — and server B exists only to prove a Device's
  // Entries follow its own Server URL setting, never the origin that served
  // its page. Playwright starts both and waits for each to answer its own
  // readiness URL before running any test.
  webServer: [
    {
      // issue #67: a deterministic OpenAI-compatible double for Reflection's
      // chat/embedding calls — see llm-stub.ts. Started before server A
      // (order matters here: server A's own MEOLOGUE_CHAT_*/MEOLOGUE_EMBED_*
      // point at this address) so `/v1/reflect` and `/v1/sessions` are
      // already registered by the time server A answers its own readiness
      // check below.
      command: "node apps/e2e/llm-stub.ts",
      cwd: repoRoot,
      env: { PORT: String(LLM_STUB_PORT) },
      url: `${LLM_STUB_URL}/health`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
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
