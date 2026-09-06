import { test as base, expect } from "@playwright/test";
import { resetServer } from "./helpers";

/**
 * The `test`/`expect` every spec in this suite imports instead of
 * `@playwright/test` directly — issue #190's structural fix, widened by
 * issue #207 from Tasks alone to everything the Server holds.
 *
 * This suite runs every spec against one shared Server (todo.spec.ts's own
 * header comment already said as much, before this file existed), and a
 * Task has no per-Device scope for the Server to isolate along
 * (`resetServer`'s own doc comment — server/migrations/0010_create_tasks.sql
 * has no owner column), so a Task any earlier test created is otherwise
 * visible to every test that runs after it, for the life of the run. #190
 * fixed that for `tasks` alone; #207 found the identical leak in every
 * other table the Server holds. It just took longer to notice, because
 * nothing else read back an absolute count the way `todo.spec.ts` once
 * did — `date-picker.spec.ts`/`search.spec.ts`/`composer.spec.ts` instead
 * lost specific rows to `@tanstack/react-virtual`'s render window once the
 * corpus a full run leaves behind grew past what fits on screen, and
 * `reflection.spec.ts`'s Grounding lost a specific row to a *ranked,
 * bounded* read of the same growing corpus (issue #205) — both symptoms
 * that look nothing like "wrong count" but come from the identical cause.
 *
 * `resetServer` runs here, in an `auto: true` fixture, rather than as a
 * line each spec is expected to remember to call — that would only move
 * the convention this ticket exists to remove from "know the leak exists"
 * to "know to call this." Importing `test` from this file instead of
 * `@playwright/test` is the one thing a new spec still has to do, and every
 * existing spec in this suite already does the equivalent (importing
 * `openDestination`/`sendEntry`/etc. from `./helpers`) purely by copying an
 * existing file as its starting point — the same precedent carries this.
 *
 * `auto: true` and no declared dependency on `page`/`context`: this fixture
 * does a plain, synchronous `docker exec` round trip with no browser
 * involvement, so its own ordering relative to page/context setup doesn't
 * matter — what matters is only that it finishes before the test BODY runs,
 * which every fixture (declared or `auto`) is already guaranteed to do. A
 * spec file's own `test.beforeEach` (`digest-fit.spec.ts` is the one that
 * has one, seeding its own Digests) still runs after this fixture, not
 * before it — Playwright resolves every fixture a test or its hooks need
 * ahead of running any hook body, and an autouse fixture with no declared
 * dependency has nothing to wait on, so it resolves first. A spec that
 * seeded data in its own `beforeEach` and then had this fixture wipe it out
 * from underneath would be exactly backwards from what "before every test"
 * is supposed to mean.
 *
 * Requires `playwright.config.ts`'s `workers: 1` to actually hold: with more
 * than one worker, two different spec files' tests can run concurrently in
 * separate OS processes against this same shared Server, and one test's
 * `resetServer` could truncate a row a *different*, concurrently-running
 * test just created. `workers: 1` is what makes "before every test" a well
 * defined moment at all.
 */
export const test = base.extend<{ resetServer: undefined }>({
  resetServer: [
    // Playwright statically parses this first parameter to learn which
    // fixtures a fixture function depends on, so it has to be written as an
    // object-destructuring pattern even though this one depends on nothing
    // — a plain unused parameter name isn't enough.
    // biome-ignore lint/correctness/noEmptyPattern: required by Playwright's own fixture-dependency parsing, see above.
    async ({}, use) => {
      resetServer();
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
