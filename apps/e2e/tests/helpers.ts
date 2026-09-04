import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { POSTGRES_CONTAINER, SERVER_A_DATABASE, SERVER_A_URL, SERVER_B_DATABASE } from "../servers";

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
 * Returns the id of the Entry whose body CONTAINS `fragment`, once one
 * exists on the Server — the same poll `waitForEntryId` runs, loosened to a
 * substring match for the one case where Send does not store the literal
 * text a test typed. Promotion (issue #173, ADR 0048) rewrites a bare
 * `- [ ] <label>` checklist line into `- [ ] [[task:id|label]]` the moment
 * it reaches a real Task, so a test that sends a completed-checklist Entry
 * and then looks it up by its full typed string never finds the row —
 * `waitForEntryId`'s exact match is checking for text Promotion has already
 * rewritten. `fragment` should be the label alone, the part Promotion
 * leaves untouched, not the leading `- [ ] ` marker.
 */
export async function waitForEntryIdContaining(
  fragment: string,
  database: string,
  timeoutMs = 20_000,
): Promise<string> {
  return pollSql(
    database,
    `select id from entries where body like ${sqlLiteral(`%${fragment}%`)};`,
    timeoutMs,
  );
}

/**
 * The Entry's own `seq` on the Server, right now — a snapshot, not a poll.
 * ADR 0028: `seq` is reassigned on every write (insert OR edit), never
 * merely on read, so it is the strongest signal composer.spec.ts's
 * dirty-only-commit test has that "closing an unedited Entry" genuinely
 * never wrote anything: a real (even a no-op-content) `UPDATE` would move
 * this number, where reading — or opening the Composer and closing it
 * again — never does.
 */
export function entrySeq(id: string, database: string): string | undefined {
  return sqlScalar(database, `select seq from entries where id = ${sqlLiteral(id)};`);
}

/**
 * Waits until the Task whose own `content` is `content` has a non-null
 * `completed_at` on the Server (`server/migrations/0010_create_tasks.sql`)
 * — issue #181's own coordinator gap-fix report: a UI assertion that the
 * checkbox *reads* checked proves the local store already agrees (the
 * query cache backing `DayTasksRow`'s own `checked` only ever updates once
 * `completeTask`'s mutation resolves, which awaits the real local write),
 * but it says nothing about whether the write has propagated any further
 * than this one render. A test that then reloads immediately is racing
 * Sync's own `requestSync()` — fired, but never awaited, from inside that
 * same mutation's `onSuccess` (`use-tasks.ts`) — against the reload's own
 * fresh boot. Waiting for the Server's own copy to agree first is the
 * identical "wait for the causally-later, externally-checkable condition"
 * discipline `waitForTombstone`/`waitForEntryId` just above already use
 * for an Entry; this is that same discipline for a Task's completion.
 * `content`, not `id`: this suite has no door onto a freshly-minted Task's
 * own id (Promotion mints it client-side, from a plain checkbox line), and
 * `uniqueEntryBody`'s own randomUUID suffix already keeps content unique
 * across a test run the identical way it does for an Entry's `body`.
 *
 * `timeoutMs` defaults to double `waitForEntryId`/`waitForTombstone`'s own
 * 20s, not because completing a Task is inherently slower than Sending or
 * deleting an Entry, but because of *where in this file* the one caller
 * that matters sits: at the time this default was measured, issue #190
 * meant every earlier test in `composer.spec.ts` leaked a Task into today's
 * Day block, so by the time this fired the Server was fielding Sync
 * requests for a real, accumulated backlog rather than the single-row case
 * `waitForEntryId`'s own 20s was measured against. `SYNC_INTERVAL_MS`
 * (`@meologue/core`) is 5s — a request that gets coalesced behind an
 * already-in-flight one, or simply takes longer under the load a busy
 * suite run puts on the Server, can need more than one or two ticks to
 * land. Confirmed by reproducing a real full-file run at load ~11.6/16.4:
 * a completion this function was asked to find took longer than 20s to
 * reach the Server, not never.
 *
 * Issue #190 is now fixed (`fixtures.ts`'s `resetTasks` fixture — this same
 * file), so a fresh measurement would likely find `waitForEntryId`'s own
 * 20s enough again; the wider budget is left in place rather than tightened
 * back down; it costs nothing on a test that finishes well within it, and
 * general machine-load variance (the actual subject of issue #112) is still
 * a real reason a poll can run long even with nothing left accumulating.
 */
export async function waitForTaskCompleted(
  content: string,
  database: string,
  timeoutMs = 40_000,
): Promise<void> {
  await pollSql(
    database,
    `select 1 from tasks where content = ${sqlLiteral(content)} and completed_at is not null;`,
    timeoutMs,
  );
}

/**
 * The inverse of `waitForTaskCompleted` above, for a Task that has just been
 * *un*-ticked — the Day block writes in both directions now, so a test that
 * reloads to prove an un-tick reached the store needs the same "wait for the
 * Server's own copy to agree first" step the tick already needed, for the
 * identical reason: `uncompleteTask`'s own mutation fires `requestSync()`
 * from `onSuccess` without awaiting it (`use-tasks.ts`), so reloading right
 * after the UI updates races that push against whatever a periodic pull
 * already in flight hands the fresh boot back.
 *
 * The query names `content` as well as `completed_at is null`, so it can only
 * pass once a row for this Task actually exists on the Server — a bare
 * `completed_at is null` over the table would be satisfied by any other Task
 * and would pass without the un-tick ever arriving.
 */
export async function waitForTaskUncompleted(
  content: string,
  database: string,
  timeoutMs = 40_000,
): Promise<void> {
  await pollSql(
    database,
    `select 1 from tasks where content = ${sqlLiteral(content)} and completed_at is null;`,
    timeoutMs,
  );
}

/**
 * Waits until the Server's own copy agrees that `beforeContent`'s Task
 * sorts before `afterContent`'s Task — `order_key` compared the same way
 * `order-key.ts`'s own `compareOrder` does (`a.orderKey < b.orderKey`),
 * lexicographically, ascending.
 *
 * The same "wait for the Server to agree before reloading" discipline
 * `waitForTaskCompleted`'s own doc comment already gives for a completion,
 * applied to a reorder instead: a drag-and-drop's `commitDrop` writes the
 * new `order_key` locally and fires `requestSync()` the identical
 * fire-and-forget way `completeTask` does (`use-tasks.ts`), so a
 * `page.reload()` right after a drop is racing that push against whatever
 * a periodic pull already in flight hands the fresh boot back — a pull
 * that still carries the Server's own pre-drop order can land after the
 * reload and overwrite the very swap a test just watched render, purely
 * because the corresponding push hadn't reached the Server yet. Confirmed
 * flaky on a real full-file run, this test's own reorder-then-reload step
 * specifically, only at real load (~10-13): reproduced twice in five tries
 * at that load, and not at all at a quieter one — the signature of exactly
 * this race, not a deterministic bug.
 */
export async function waitForTaskOrder(
  beforeContent: string,
  afterContent: string,
  database: string,
  timeoutMs = 20_000,
): Promise<void> {
  await pollSql(
    database,
    `select 1 from tasks a, tasks b
     where a.content = ${sqlLiteral(beforeContent)}
       and b.content = ${sqlLiteral(afterContent)}
       and a.order_key < b.order_key;`,
    timeoutMs,
  );
}

/**
 * Waits until the Server's own copy agrees that `childContent`'s Task has
 * `parentContent`'s Task as its own `parent_id` — the same "wait for the
 * Server to agree before asserting anything" discipline `waitForTaskOrder`'s
 * own doc comment already gives for a reorder, applied to a reparent
 * instead: `setTaskParent` (task-tree.tsx's own `handleIndent`, reached from
 * `Alt`+`ArrowRight`, and `handleNestDrop`, reached from a drag) writes the
 * new `parent_id` locally and fires `requestSync()` the identical
 * fire-and-forget way every other Task mutation does (`use-tasks.ts`'s own
 * `afterLocalWrite`), so asserting anything that depends on the Server's own
 * state right after the gesture races that push against whatever pull is
 * already in flight — exactly `waitForTaskOrder`'s own race, for a different
 * column.
 *
 * Naming both `content`s, joined through `parent_id`, rather than polling
 * `parent_id is not null` alone, is deliberate, and the same care
 * `waitForTaskCompleted` above takes in naming the Task it is waiting on:
 * this can only pass once the row for *this* child actually names *this*
 * parent, not merely once some Task somewhere has acquired some parent —
 * which, on a shared Server every spec in this suite writes to, is a
 * condition some other test's leftover could satisfy on its own.
 *
 * This is also what turns a keyboard gesture that never reached its target
 * — the reparent action itself never firing, as opposed to firing and
 * merely taking a while to reach the Server — into a clear, named timeout
 * here ("no row agrees" for the full budget) rather than a confusing
 * mismatch several assertions later against whatever the DOM happened to
 * still show.
 */
export async function waitForTaskParent(
  childContent: string,
  parentContent: string,
  database: string,
  timeoutMs = 20_000,
): Promise<void> {
  await pollSql(
    database,
    `select 1 from tasks child, tasks parent
     where child.content = ${sqlLiteral(childContent)}
       and parent.content = ${sqlLiteral(parentContent)}
       and child.parent_id = parent.id;`,
    timeoutMs,
  );
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
 * Writes one Digest row straight into the database the suite is running
 * against.
 *
 * SQL through `docker exec` rather than driving the Server's own writer:
 * `server/src/digest.rs`'s resume rule means a cold e2e database would need
 * real Entries, a real embedding pass and a real LLM call before any Digest
 * existed, and none of that is what a Digest test on the client is about.
 * `digest.spec.ts`'s own header comment records the full reasoning.
 *
 * `on conflict ... do nothing` mirrors `server/src/digest.rs::insert_digest`
 * exactly, for the same reason it exists there: re-running a spec locally
 * against a database that already holds these rows must stay a no-op rather
 * than a duplicate-key failure. `grounding_entry_ids` is an empty array —
 * no spec that seeds this way asserts on a Digest's Grounding, so there is
 * no Entry for these rows to reference.
 */
export function seedDigest(
  period: "day" | "week" | "month",
  periodStart: string,
  body: string,
  database: string,
): void {
  // `revision` is named explicitly, and so is the conflict target, because
  // issue #132 replaced `unique (period, period_start)` with
  // `unique (period, period_start, revision)` — Postgres rejects a conflict
  // target that matches no unique constraint outright, so the older
  // two-column form does not degrade here, it errors.
  //
  // A seeded Digest is always the Server's own first-generation write
  // (revision 1), and `source_seq` is left at its default 0: every date
  // these specs seed predates the Entries they create by years, so no Entry
  // ever falls inside a seeded Period and the staleness watermark is never
  // consulted for one.
  runSql(
    "insert into digests (id, period, period_start, body, grounding_entry_ids, revision) " +
      `values (${sqlLiteral(randomUUID())}, ${sqlLiteral(period)}, ${sqlLiteral(periodStart)}, ${sqlLiteral(body)}, '{}', 1) ` +
      "on conflict (period, period_start, revision) do nothing;",
    database,
  );
}

/**
 * Removes a seeded Digest again.
 *
 * Worth having because `/v1/digest/:period` answers with the NEWEST Digest
 * of that Period, so two specs that both seed one are not independent: the
 * later date wins for whichever of them runs second. A spec that seeds a
 * Digest newer than another spec's therefore has to take it away again —
 * `scripts/e2e.sh` recreates the databases per run, not per file.
 */
export function deleteDigest(
  period: "day" | "week" | "month",
  periodStart: string,
  database: string,
): void {
  runSql(
    `delete from digests where period = ${sqlLiteral(period)} and period_start = ${sqlLiteral(periodStart)};`,
    database,
  );
}

/**
 * Deletes every row from `tasks`, on both e2e databases — issue #190's
 * structural fix. `fixtures.ts`'s own autouse fixture calls this before
 * every single test, not merely at a spec-file boundary, so the guarantee
 * holds regardless of which earlier file — or even which earlier test in
 * the SAME file — happened to create a Task.
 *
 * A Task has no per-Device or per-user scope to isolate along in the first
 * place (server/migrations/0010_create_tasks.sql's own header comment:
 * "meologue is one person's journal and one person's task list" — every
 * Device pulls every row), so the only place isolation between one test and
 * the next can live is the shared table itself. Truncating it is cheap
 * (`docker exec`/`psql`, the same round trip `pollSql` already pays inside
 * this same test run) next to the cost a real per-file Server or database
 * would add on top of the two this suite already boots.
 *
 * Both databases, not only `SERVER_A_DATABASE`: multi-server.spec.ts is the
 * one spec that ever talks to `SERVER_B_DATABASE`, and it does not exercise
 * Todo, but resetting a database this suite never dirties is a no-op, not a
 * risk — leaving it out on the assumption "nothing writes Tasks there today"
 * is exactly the kind of convention this fix is trying not to depend on.
 *
 * Deliberately `tasks` only, not `entries`: every other spec that reads back
 * a broad surface (History, Search) already matches its own row by
 * `uniqueEntryBody`'s random content rather than by counting the whole page
 * (todo.spec.ts's own former `toHaveCount` — see git history — was the one
 * assertion counting a whole surface instead). Widening the reset to
 * `entries` would be a second, unasked-for change with a real cost
 * (reflection.spec.ts's embeddings, search.spec.ts's index) for no failure
 * this ticket needs it to fix.
 */
export function resetTasks(): void {
  for (const database of [SERVER_A_DATABASE, SERVER_B_DATABASE]) {
    runSql("delete from tasks;", database);
  }
}

function runSql(sql: string, database: string): void {
  execFileSync("docker", [
    "exec",
    POSTGRES_CONTAINER,
    "psql",
    "-U",
    "meologue",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
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
  name: "Composer" | "Reflect" | "Digest" | "Todo" | "Settings",
): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name }).click();
}

/**
 * Issue #155's Composer field, ready to type into. `getByPlaceholder` still
 * finds it — composer.tsx sets a literal `placeholder` HTML attribute on
 * the `contenteditable` root purely so this locator keeps working, even
 * though a `<div>` has no native placeholder semantics of its own (verified
 * against playwright-core's own `getByAttributeTextSelector`, which is a
 * plain `[placeholder=...]` attribute match, not restricted to `<input>`/
 * `<textarea>`).
 */
export function composerField(page: Page): Locator {
  return page.getByPlaceholder("What's on your mind?");
}

/**
 * Types `body` into the Composer via real keystrokes and sends it.
 *
 * `pressSequentially`, not `fill()`: the field is a ProseMirror
 * `contenteditable` now (issue #155), not a `<textarea>`, and `fill()`'s
 * bulk DOM write bypasses the `beforeinput`/`input` events ProseMirror's
 * `DOMObserver` and `prosemirror-inputrules`' `handleTextInput` are built
 * to read — real per-character keystrokes are the one interaction path
 * every part of the editor (input rules included) is guaranteed to
 * understand correctly, which is exactly what a body containing `[[`/`- `/
 * etc. (several specs' own bodies do) needs to land as. Every existing
 * caller's body is one line (no `\n`), so `pressSequentially` alone — with
 * no special-casing for Enter — is enough to reproduce it.
 */
export async function sendEntry(page: Page, body: string): Promise<void> {
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(body);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * Patches this page's own no-argument `new Date()`/`Date.now()` so a test
 * can put Entries on two different local days without a real day elapsing
 * — day-referrers.ts (issue #147) excludes a same-day self-Reference, so
 * proving a real, later Reference needs exactly that.
 *
 * Deliberately not Playwright's own `page.clock`: that also virtualizes
 * `requestAnimationFrame` and every timer, and this app's own
 * scroll-to-newest (`usePinnedScroll`, on top of `@tanstack/react-virtual`'s
 * own positioning) genuinely depends on those ticking — installing
 * `page.clock` left the thread stuck wherever its very first paint
 * happened to land, never actually reaching the newest Entry. This patch
 * touches nothing but what a bare `new Date()`/`Date.now()` reports; every
 * timer and animation frame keeps running in real time.
 *
 * Must be called before `page.goto` — `addInitScript` only reaches
 * documents navigated to after it's registered. Use `advanceDateByDays`
 * afterward to move the offset; it starts at zero (today, unshifted).
 */
export async function installDateOffset(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const RealDate = window.Date;
    let offsetMs = 0;
    class OffsetDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(RealDate.now() + offsetMs);
        } else {
          // @ts-expect-error — forwarding whatever arity the caller used to the real Date.
          super(...args);
        }
      }
      static override now(): number {
        return RealDate.now() + offsetMs;
      }
    }
    Object.defineProperty(window, "__setDateOffsetMs", {
      value: (ms: number) => {
        offsetMs = ms;
      },
    });
    window.Date = OffsetDate as unknown as DateConstructor;
  });
}

/** Shifts every subsequent no-argument `new Date()`/`Date.now()` on this page forward by `days` — see `installDateOffset`'s own comment. */
export async function advanceDateByDays(page: Page, days: number): Promise<void> {
  await page.evaluate(
    (ms) => {
      (window as unknown as { __setDateOffsetMs: (ms: number) => void }).__setDateOffsetMs(ms);
    },
    days * 24 * 60 * 60 * 1000,
  );
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
 * The element a finger actually picks up (#127) — `entry-bubble.tsx` puts
 * `data-swipe-target` on the bubble's own fill, one level inside the
 * `[data-slot="bubble"]` row `entryRow` matches. The distinction matters:
 * the recogniser resolves its target with `closest()`, so a gesture
 * dispatched on the row around the bubble finds nothing.
 */
export function entrySwipeTarget(page: Page, body: string): Locator {
  return page.locator("[data-swipe-target]").filter({ hasText: body });
}

/**
 * Dispatches one synthetic touch pointer event on an Entry's bubble.
 *
 * `bubbles: true` is not optional: `use-swipe-actions.ts` attaches ONE
 * recogniser to the thread's row container rather than one per row, so an
 * event that does not travel up the tree is never seen at all.
 *
 * Playwright's own `page.touchscreen` only taps, and mouse emulation
 * produces `pointerType: "mouse"`, which the recogniser deliberately
 * ignores so that dragging to select still selects. Dispatching the events
 * is what expresses a finger here. It is not a substitute for the device —
 * #127 was verified against real touch on Android — but it is what keeps
 * the gesture from silently rotting in a real browser, at real layout,
 * where jsdom cannot see a bubble's width at all.
 */
async function touchAt(target: Locator, type: string, x: number, y: number): Promise<void> {
  await target.dispatchEvent(type, {
    pointerId: 1,
    pointerType: "touch",
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
}

/** Where a swipe on this Entry starts, and the y it stays on throughout. */
export async function swipeOrigin(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error("the Entry's bubble has no box to swipe");
  return { x: box.x + box.width - 8, y: box.y + box.height / 2 };
}

/** Just past the recogniser's 12px horizontal threshold. */
export const SWIPE_CONFIRM_PX = 13;
/** Comfortably past half the 48px peek limit, so the release opens. */
export const SWIPE_OPEN_PX = 40;

export async function swipeEntryLeft(page: Page, body: string): Promise<void> {
  const target = entrySwipeTarget(page, body);
  const { x, y } = await swipeOrigin(target);
  await touchAt(target, "pointerdown", x, y);
  await touchAt(target, "pointermove", x - SWIPE_CONFIRM_PX, y);
  await touchAt(target, "pointermove", x - SWIPE_CONFIRM_PX - SWIPE_OPEN_PX, y);
  await touchAt(target, "pointerup", x - SWIPE_CONFIRM_PX - SWIPE_OPEN_PX, y);
}

/** A finger landing and lifting on an Entry without moving. */
export async function tapEntry(page: Page, body: string): Promise<void> {
  const target = entrySwipeTarget(page, body);
  const { x, y } = await swipeOrigin(target);
  await touchAt(target, "pointerdown", x, y);
  await touchAt(target, "pointerup", x, y);
}

export { touchAt };

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
 *
 * `ControlOrMeta+A`/`Backspace` clears the seeded body before typing
 * `newBody`. `ControlOrMeta` is Playwright's own cross-platform select-all
 * modifier, so this keeps working if the suite ever runs anywhere but the
 * headless Chromium it uses today. The clear cannot be a `fill("")` for the
 * same reason `sendEntry` cannot use `fill()` at all — see `composerField`'s
 * own comment: a bulk DOM write bypasses the events ProseMirror reads.
 */
export async function editEntryViaMenu(
  page: Page,
  currentBody: string,
  newBody: string,
): Promise<void> {
  const row = entryRow(page, currentBody);
  await row.hover();
  // `exact: true` — issue #181 gave a referenced Task's own words a real
  // `<button>` (entry-row.tsx's `TaskReferenceItem`), sitting inside this
  // same row. `getByRole`'s `name` is substring-matched and case-
  // insensitive by default, so a fixture body containing the word "edit"
  // (a real, exercised case — composer.spec.ts's own
  // "composer-task-reference-edit" fixture) makes that button match `{
  // name: "Edit" }` too, alongside the real Edit button
  // (`entry-actions.tsx`'s own `aria-label="Edit"`, nothing else in its
  // name) — a strict-mode violation Playwright refuses to guess through.
  // `exact: true` is what makes this mean the action, not any button
  // whose visible text happens to contain those four letters.
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = composerField(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await editor.pressSequentially(newBody);
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
