import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { POSTGRES_CONTAINER, SERVER_A_URL } from "../servers";

/** A body unique to this test run, so leftover rows from a prior local run never collide. */
export function uniqueEntryBody(label: string): string {
  return `${label} ${randomUUID()}`;
}

// Mirrors packages/core/src/protocol.ts's `SYNC_INTERVAL_MS` (5000).
// Duplicated rather than imported — apps/e2e has no dependency on
// `@meologue/core` today, and digest.spec.ts's own header comment records
// this suite's preference for zero new dependencies over the convenience of
// one. Several specs size a "prove nothing happened" wait off a multiple of
// this; keep it in step by hand if the real constant ever changes.
export const SYNC_TICK_MS = 5_000;

/**
 * Doubles an embedded single quote — the one escape a plain SQL string
 * literal needs. Every caller here passes a `uniqueEntryBody` value or a
 * UUID, neither of which contains anything else worth escaping; this is
 * defensive rather than load-bearing, the same posture digest.spec.ts's own
 * `sqlLiteral` takes.
 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Runs `sql` (expected to return at most one row, one column) against
 * `database` inside the Sandbox Postgres container and returns that value,
 * or `undefined` if the query returned no rows. `docker exec`/`psql`, not a
 * client library — the same zero-new-dependency route digest.spec.ts's own
 * header comment already chose for seeding into this same container; this
 * is the read-side of that idea.
 */
function sqlScalar(database: string, sql: string): string | undefined {
  const out = execFileSync("docker", [
    "exec",
    POSTGRES_CONTAINER,
    "psql",
    "-U",
    "meologue",
    "-d",
    database,
    "-t",
    "-A",
    "-c",
    sql,
  ])
    .toString()
    .trim();
  return out === "" ? undefined : out;
}

/**
 * Polls `probe` until it returns a value or `timeoutMs` elapses, then
 * throws — the replacement for a `page.waitForTimeout` guess at how long
 * some Server-side background job (the embedding worker, a synced
 * tombstone) takes to finish. Neither has an HTTP surface this suite can
 * watch directly (server/tests/embedding.rs's own `wait_for_embedding`
 * polls the same database one layer down, for the same reason), so this
 * polls the database scripts/e2e.sh already hands the suite a clean copy
 * of. `pollMs` is short on purpose: on a working machine the condition is
 * usually true on the first or second check, so the poll cadence should
 * not be what makes this slow — only a loaded machine should ever spend
 * close to `timeoutMs`.
 */
async function pollSql(
  database: string,
  sql: string,
  timeoutMs: number,
  pollMs = 250,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = sqlScalar(database, sql);
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`pollSql: no row within ${timeoutMs}ms for: ${sql}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Waits until `body`'s Entry has a non-null `embedding` — the condition
 * reflection.spec.ts's Grounding disclosure actually depends on
 * (`retrieve_nearest`'s `embedding is not null` guard, server/src/reflect.rs).
 * Covers both legs of the real latency: the Entry reaching the Server at
 * all (sync's own poll interval, `SYNC_TICK_MS`) and the embedding worker
 * picking it up, which is normally near-instant off the non-blocking hint
 * `/v1/sync` drops (server/src/sync.rs, server/src/embedding.rs) rather
 * than the 30s fallback scan — but neither leg has a fixed duration, and a
 * loaded machine can stretch both well past what a fixed sleep assumed.
 */
export async function waitForEmbedding(
  body: string,
  database: string,
  timeoutMs = 60_000,
): Promise<void> {
  await pollSql(
    database,
    `select 1 from entries where body = ${sqlLiteral(body)} and embedding is not null;`,
    timeoutMs,
  );
}

/**
 * Returns `body`'s Entry id once it exists on the Server, polling the same
 * way `waitForEmbedding` does. Needed before deleting an Entry a test later
 * wants to confirm the tombstone of: a delete blanks `body` server-side
 * (server/src/sync.rs's `insert_entries` sets it to the client's own
 * already-blanked value — see edit-delete.spec.ts's "delete is terminal"
 * test), so `body` stops being a usable handle the moment the tombstone
 * lands. The id is the only handle that survives that.
 */
export async function waitForEntryId(
  body: string,
  database: string,
  timeoutMs = 20_000,
): Promise<string> {
  return pollSql(database, `select id from entries where body = ${sqlLiteral(body)};`, timeoutMs);
}

/**
 * Waits until the Entry with this id has a non-null `deleted_at` — the
 * condition a delete's tombstone has actually reached the Server, rather
 * than assuming a fixed sleep gave it enough time. `id` (not `body`) since
 * `waitForEntryId`'s own doc comment explains why body stops identifying
 * the row once it is tombstoned.
 */
export async function waitForTombstone(
  id: string,
  database: string,
  timeoutMs = 20_000,
): Promise<void> {
  await pollSql(
    database,
    `select 1 from entries where id = ${sqlLiteral(id)} and deleted_at is not null;`,
    timeoutMs,
  );
}

/**
 * A Playwright `storageState` that seeds `meologue.server-url` for the app's
 * own origin before any page script runs — sync is opt-in (ADR 0011), so
 * without this every context would load with sync off and none of the
 * suite's assertions about syncing would ever be exercised. Every context
 * the suite opens (the config's default `page` fixture, and each device
 * `openTwoDevices` creates) needs this seeded explicitly; there is no
 * implicit fallback left to fall back on.
 */
export function serverUrlStorageState(serverUrl: string) {
  return {
    cookies: [],
    origins: [
      { origin: SERVER_A_URL, localStorage: [{ name: "meologue.server-url", value: serverUrl }] },
    ],
  };
}

export interface TwoDevices {
  deviceA: BrowserContext;
  deviceB: BrowserContext;
  pageA: Page;
  pageB: Page;
}

export interface TwoDevicesOptions {
  /** The Server URL each Device's context is seeded with — defaults to the suite's one Server. */
  serverUrlA?: string;
  serverUrlB?: string;
}

/**
 * Two independent BrowserContexts, each already loaded and each seeded with
 * a Server URL — standing in for two Devices. Defaults to both pointing at
 * the same Server; multi-server.spec.ts overrides `serverUrlA`/`serverUrlB`
 * to prove a Device follows whichever Server URL it was given, not which
 * origin served its page.
 */
export async function openTwoDevices(
  browser: Browser,
  options: TwoDevicesOptions = {},
): Promise<TwoDevices> {
  const { serverUrlA = SERVER_A_URL, serverUrlB = SERVER_A_URL } = options;
  const deviceA = await browser.newContext({ storageState: serverUrlStorageState(serverUrlA) });
  const deviceB = await browser.newContext({ storageState: serverUrlStorageState(serverUrlB) });
  const pageA = await deviceA.newPage();
  const pageB = await deviceB.newPage();
  // `/composer`, not `/`: ADR 0036's root screen sits outside
  // EntryStoreLayout so it renders whether or not the store opens, which
  // means landing there would leave both Devices with no store to sync.
  await pageA.goto("/composer");
  await pageB.goto("/composer");
  return { deviceA, deviceB, pageA, pageB };
}

export async function closeDevices(devices: TwoDevices): Promise<void> {
  await devices.deviceA.close();
  await devices.deviceB.close();
}

/**
 * Opens one of the four destinations the way a reader does: from the root
 * screen, by tapping its row.
 *
 * ADR 0036 replaced the persistent nav with a chat list, so there is no
 * longer a nav link on every page to click — a destination is reached from
 * `/` and left again with Back. Specs that only need to *be* somewhere
 * should `page.goto` it directly; this exists for the ones whose point is
 * that the navigation itself works.
 *
 * The row's accessible name is its label plus its summary line, so the
 * substring match Playwright does by default is what makes `"Composer"`
 * still find it.
 */
export async function openDestination(
  page: Page,
  name: "Composer" | "Reflect" | "Digest" | "Settings",
): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name }).click();
}

export async function sendEntry(page: Page, body: string): Promise<void> {
  await page.getByPlaceholder("What's on your mind?").fill(body);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * Real OS-level tab backgrounding isn't controllable through Playwright, so
 * this drives the Page Visibility API directly, the same signal `apps/web`'s
 * continuous-sync wiring listens to (see wake-signals.web.ts).
 */
export async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", {
      value: hidden ? "hidden" : "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/**
 * The one History row whose body is exactly `body`. Every row now carries its
 * own Edit/Delete buttons (issue #78) instead of sharing a single context
 * menu, so a bare `getByRole("button", { name: "Edit" })` matches every
 * rendered row at once. Scoping through the row is what makes "this Entry's
 * Edit" expressible at all.
 *
 * `body` must be exact and unique in the DOM (uniqueEntryBody's randomUUID
 * suffix guarantees that), since the row is found via its rendered text.
 */
export function entryRow(page: Page, body: string): Locator {
  // `bubble`, not `entry-row`: ADR 0036 made the thread a chat thread, and
  // `entry-bubble.tsx` renders its Entries. `entry-row.tsx` still exists and
  // still carries `data-slot="entry-row"`, but only for the two surfaces
  // that stayed lists — Reflection's Grounding disclosure and Search
  // results — so matching it here would find an Entry everywhere except the
  // History this helper is named for.
  return page.locator('[data-slot="bubble"]').filter({ hasText: body });
}

/**
 * Hovers a History row, revealing its Edit/Delete buttons. They sit behind
 * `@media (hover: hover)` and are `opacity-0` until the row is hovered — a
 * headless Chromium reports as hover-capable, so they are in the DOM, and the
 * hover is what makes them a target a real user could hit. Asserting on them
 * without it would pass for the wrong reason.
 */
export async function hoverEntryRow(page: Page, body: string): Promise<void> {
  await entryRow(page, body).hover();
}

/**
 * Edit -> Composer flow: reveals the row's actions, chooses Edit (which seeds
 * the docked Composer with the Entry's current body — see composer.tsx's
 * `editingEntry`), replaces the field's contents with `newBody`, and commits
 * via the Send control, since Composer routes Send to `onCommitEdit` while
 * `editingEntry` is set rather than to `onSend`.
 *
 * Send is a click, not the keyboard: issue #76 made plain Enter insert a
 * newline, and the chord that does send differs by build target, so a click
 * is the one gesture meaning "send" on every platform this might run against.
 */
export async function editEntryViaMenu(
  page: Page,
  currentBody: string,
  newBody: string,
): Promise<void> {
  const row = entryRow(page, currentBody);
  await row.hover();
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByPlaceholder("What's on your mind?").fill(newBody);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * Delete via the row's actions, then through the confirmation issue #82 put
 * in front of it. Delete no longer fires on the spot and there is no Undo
 * toast any more — confirmation replaced it rather than joining it, so a test
 * that stops at the first click deletes nothing at all.
 */
export async function deleteEntryViaMenu(page: Page, body: string): Promise<void> {
  const row = entryRow(page, body);
  await row.hover();
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
}
