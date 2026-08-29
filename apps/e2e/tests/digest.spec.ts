import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { openDestination } from "./helpers";

// Digest covered end to end (issue #73): open Digest from the root screen,
// see a
// card with a Period, its date range and prose, open it, see the full
// prose, then step back to an earlier Digest — proving the Server
// (server/src/digest.rs's two GET handlers), the wire shape
// (`DigestResponse`) and the client (apps/web's digest-page.tsx and
// digest-reader-page.tsx) all agree, in a real browser rather than in
// three separate unit tests that each assume the others are right.
//
// ---------------------------------------------------------------------
// Why this spec seeds its own Digests, rather than waiting on the worker
// ---------------------------------------------------------------------
// `server/src/digest.rs`'s resume rule (docs/adr/0027) means a cold e2e
// database never produces a Digest on its own within a test run: with no
// prior Digest of a Period type, the *only* Period the worker ever
// considers is the single most-recently-completed one
// (`period::most_recently_completed`) — and every Entry any spec in this
// suite creates lands inside the *current*, still-in-progress day, never
// a completed one. So the worker's own scan (`fill_period`) always finds
// nothing to write for the whole lifetime of a test run, and waiting on
// it would make this spec either hang or (worse) pass vacuously the one
// time it didn't. This spec writes `digests` rows directly instead, with
// SQL, before ever loading the page — see `seedDayDigest` below.
//
// ---------------------------------------------------------------------
// Why SQL, and why `docker exec` rather than a Postgres client library
// ---------------------------------------------------------------------
// apps/e2e has no database dependency today (see its package.json), and
// issue #73 asks to prefer whichever seeding approach avoids adding one.
// Both routes it names — inserting `digests` rows directly, or inserting
// Entries in a completed Period plus an anchor row and letting the worker
// fill forward — hit the identical gap: neither can run from Node without
// *some* way to reach Postgres. `docker exec`ing straight into the same
// Sandbox Postgres container `scripts/e2e-server.sh` already assumes
// exists (its own `docker compose up`) closes that gap with zero new
// dependencies — `child_process.execFileSync` and `psql`, both already
// present, the same "no new dependency" call `llm-stub.ts`'s own doc
// comment makes for using bare `node:http` instead of a real server
// framework. That also settles the choice between the two routes: seeding
// `digests` directly is strictly fewer moving parts than seeding Entries
// and waiting on the worker's timing and an LLM round-trip through the
// stub, for coverage this spec doesn't need — the resume rule itself
// already has its own real, non-e2e coverage in `server/tests/digest.rs`.
// ---------------------------------------------------------------------
//
// The rows this test inserts below are real writes, so the database it
// names has to be one nobody minds it writing to. Before issue #74 that
// took care: this named the developer's own container and database, and
// only `scripts/e2e.sh` renaming their corpus aside kept the two apart.
// Both names below now point into the Sandbox Postgres instead, at the
// database `scripts/e2e.sh` drops and recreates empty before every run —
// so there is no corpus in reach to damage, and no restore step to skip.
// They must stay in step with `scripts/e2e-server.sh`'s DATABASE_URL:
// this spec seeds rows that server A is then asked to serve.

const CONTAINER = "meologue-postgres-sandbox";
const DATABASE = "meologue_e2e_a";

// Three "day" Digests, oldest first, with a deliberate multi-day gap
// between the middle and newest dates — chosen specifically so that
// stepping "Previous Digest" from the newest lands on the middle date,
// not on the calendar day immediately before it. That's the one behaviour
// most worth an e2e test here: it depends on the Server's neighbour
// lookup (`select_prev_digest_date`), the wire's `prev_date` field, and
// the client following it verbatim (`DigestStepControl`) all agreeing —
// exactly the kind of cross-layer agreement a unit test on any one layer
// can't demonstrate. A second, single-day gap sits between the oldest and
// middle dates too, so the same skip is proven twice, at two different
// gap sizes, on the way to the archive's floor.
const OLDEST_DATE = "2024-01-01";
const MIDDLE_DATE = "2024-01-03"; // gap: 2024-01-02 has no Digest
const NEWEST_DATE = "2024-01-10"; // gap: 2024-01-04 .. 2024-01-09 have no Digest

// Deliberately free of digits: `dayCard.getByText("2024")` below asserts
// on the card's own rendered date range, and a body that happened to
// contain the same substring (e.g. a literal "2024-01-10") would make
// that locator ambiguous between the two.
const OLDEST_BODY = "Seeded stub prose for the oldest day - the floor of this spec's own archive.";
const MIDDLE_BODY =
  "Seeded stub prose for the middle day - reachable only by stepping back across a gap.";
const NEWEST_BODY =
  "Seeded stub prose for the newest day - the Digest the cards page opens by default.";

/**
 * Doubles an embedded single quote — the one escape a plain SQL string
 * literal needs. Every value this spec ever passes here is a fixed
 * literal written above, never anything from outside the test, so this
 * is defensive rather than load-bearing.
 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Inserts one "day" Digest row straight into the database the e2e suite
 * is running against — see this file's header comment for why SQL,
 * issued through `docker exec`, is the seeding mechanism. `on conflict
 * ... do nothing` mirrors `server/src/digest.rs::insert_digest` exactly,
 * for the same reason it exists there: re-running this spec locally
 * against a database that already holds these rows must stay a no-op,
 * never a duplicate-key failure. `grounding_entry_ids` is `'{}'` (an
 * empty array) — this spec asserts on the Digest's prose and its Period
 * stepping, never on its Grounding, so there is no Entry for these rows
 * to reference.
 */
function seedDayDigest(periodStart: string, body: string): void {
  const sql =
    "insert into digests (id, period, period_start, body, grounding_entry_ids) " +
    `values (${sqlLiteral(randomUUID())}, 'day', ${sqlLiteral(periodStart)}, ${sqlLiteral(body)}, '{}') ` +
    "on conflict (period, period_start) do nothing;";
  execFileSync("docker", [
    "exec",
    CONTAINER,
    "psql",
    "-U",
    "meologue",
    "-d",
    DATABASE,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
}

test("open Digest from the nav, read a card, open it, and step back across a gap", async ({
  page,
}) => {
  seedDayDigest(OLDEST_DATE, OLDEST_BODY);
  seedDayDigest(MIDDLE_DATE, MIDDLE_BODY);
  seedDayDigest(NEWEST_DATE, NEWEST_BODY);

  await page.goto("/composer");
  await openDestination(page, "Digest");
  await expect(page).toHaveURL("/digest");

  // The "Last day" card (digest-page.tsx's `DigestCard`) shows the newest
  // day Digest: its own date range (`formatDigestRange`) and a teaser of
  // its prose. Asserted on the seeded year rather than the full
  // locale-rendered string, so this doesn't depend on which date style or
  // locale the browser happens to format with — that formatting already
  // has its own unit tests (apps/web/src/lib/digest-format.ts).
  const dayCard = page.getByRole("link", { name: "Last day" });
  await expect(dayCard).toBeVisible();
  await expect(dayCard.getByText("2024")).toBeVisible();
  await expect(dayCard.getByText(NEWEST_BODY)).toBeVisible();

  await dayCard.click();
  await expect(page).toHaveURL(`/digest/day/${NEWEST_DATE}`);
  await expect(page.getByText(NEWEST_BODY)).toBeVisible();

  // Stepping (issue #72) is asserted on the control's accessible name —
  // `DigestStepControl` (digest-reader-page.tsx) renders a real `<Link>`
  // with this `aria-label` whenever a neighbouring Digest exists, and a
  // real disabled `<button>` with the same label at an archive edge — so
  // the name is what identifies the control regardless of which element
  // backs it.
  const previous = page.getByRole("link", { name: "Previous Digest" });
  await expect(previous).toBeVisible();
  await previous.click();

  // The Server already resolved the previous *existing* Digest
  // (`select_prev_digest_date`), skipping every undigested day in
  // between — landing on 2024-01-03 rather than 2024-01-09 (the calendar
  // day immediately before 2024-01-10) is exactly what proves the
  // gap-skip end to end, across the Server, the wire and the client
  // together.
  await expect(page).toHaveURL(`/digest/day/${MIDDLE_DATE}`);
  await expect(page.getByText(MIDDLE_BODY)).toBeVisible();
  await expect(page.getByText(NEWEST_BODY)).toHaveCount(0);

  // One more step back, across the smaller single-day gap at
  // 2024-01-02, reaches the oldest seeded Digest — the archive's floor,
  // where `prev_date` is `None` and the control renders as a real
  // disabled `<button>` rather than vanishing (see `DigestStepControl`'s
  // own doc comment on why a disabled control, not an absent one).
  await page.getByRole("link", { name: "Previous Digest" }).click();
  await expect(page).toHaveURL(`/digest/day/${OLDEST_DATE}`);
  await expect(page.getByText(OLDEST_BODY)).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous Digest" })).toBeDisabled();
});
