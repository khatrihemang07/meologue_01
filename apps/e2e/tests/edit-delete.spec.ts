import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SERVER_A_DATABASE } from "../servers";
import {
  closeDevices,
  deleteEntryViaMenu,
  editEntryViaMenu,
  entryRow,
  openTwoDevices,
  SYNC_TICK_MS,
  sendEntry,
  uniqueEntryBody,
  waitForEntryId,
  waitForTombstone,
} from "./helpers";

/**
 * Every Entry body on screen, top to bottom, in one atomic read — DOM order,
 * not two separate `boundingBox()` round trips compared against each other.
 * Two separate round trips race a pinned-scroll reflow that can land
 * between them (composer-page.tsx's `pinnedThread`), which made an early
 * version of the position test below flaky even though the DOM order
 * (visible in a failure's own accessibility snapshot) was correct the
 * whole time. `p.whitespace-pre-wrap` is EntryBody's own paragraph
 * (entry-row.tsx) — the only `<p>` this page renders once there's at least
 * one Entry.
 */
async function entryBodiesInOrder(page: Page): Promise<string[]> {
  // A data-slot, not a tag-plus-class: the thread's Entries are bubbles
  // since ADR 0036, and their body is inline rather than a `<p>` precisely
  // so the clock time can share its last line. Matching on the markup shape
  // is what tied this to a `<p>` that no longer exists.
  return page.locator('[data-slot="bubble-body"]').allTextContents();
}

// ADR 0028: Entries stopped being append-only, and Sync stopped carrying
// Entries and started carrying changes — `nothing -> A`, `A -> B`, `A ->
// nothing` — via a compacted change log whose `seq` is reassigned on every
// write. Each test below names the one property it exists to prove, and
// why that property specifically is what the design depends on, rather
// than just re-confirming "editing/deleting works" in the abstract.

test("an edit made on one Device reaches a second with no reload — the property the compacted log exists for", async ({
  browser,
}) => {
  const devices = await openTwoDevices(browser);
  const { pageA, pageB } = devices;

  const original = uniqueEntryBody("edit-propagate-original");
  await sendEntry(pageA, original);
  // 20s, not the 10s these cross-Device waits used to carry (issue #112):
  // that margin held on a quiet machine but not under real load, and this
  // is an `expect(...)` — already a poll, resolving as soon as B's next
  // sync tick lands rather than always paying the full timeout.
  await expect(pageB.getByText(original)).toBeVisible({ timeout: 20_000 });

  // A plain `update` would leave `seq` where it was — below B's Cursor,
  // permanently unreachable (ADR 0028's Context). Reassigning `seq` on
  // write is what makes this edit show up on B's very next poll, the same
  // way a brand-new Entry would.
  const edited = uniqueEntryBody("edit-propagate-edited");
  await editEntryViaMenu(pageA, original, edited);
  await expect(pageA.getByText(edited)).toBeVisible();

  await expect(pageB.getByText(edited)).toBeVisible({ timeout: 20_000 });
  await expect(pageB.getByText(original)).toHaveCount(0);

  await closeDevices(devices);
});

test("a delete made on one Device removes it from a second, with no reload", async ({
  browser,
}) => {
  const devices = await openTwoDevices(browser);
  const { pageA, pageB } = devices;

  const body = uniqueEntryBody("delete-propagate");
  await sendEntry(pageA, body);
  await expect(pageB.getByText(body)).toBeVisible({ timeout: 20_000 });

  // A -> nothing travels as a tombstone (deleted_at set, body blanked),
  // reassigned into the log the same as an edit — this is what lets B's
  // poll notice the removal at all, rather than the row simply sitting
  // below B's Cursor forever.
  await deleteEntryViaMenu(pageA, body);
  await expect(pageA.getByText(body)).toHaveCount(0);

  await expect(pageB.getByText(body)).toHaveCount(0, { timeout: 20_000 });

  await closeDevices(devices);
});

test("an edited Entry keeps its position in History — editing does not move it", async ({
  page,
}) => {
  const older = uniqueEntryBody("position-older");
  const newer = uniqueEntryBody("position-newer");

  await page.goto("/composer");
  await sendEntry(page, older);
  // `list()` orders by `created_at DESC, id DESC` (sqlite-entry-store.ts) —
  // two Entries minted within the same millisecond tie on `created_at` and
  // fall back to an `id` compare that says nothing about send order.
  // Waiting for `older` to actually render before sending `newer` is what
  // guarantees the two get distinct `created_at` values, the same way two
  // real keystrokes from a human never land in the same millisecond.
  await expect(page.getByText(older)).toBeVisible();
  await sendEntry(page, newer);
  await expect(page.getByText(newer)).toBeVisible();

  // Reading order is oldest-to-newest top to bottom (use-history-search.ts)
  // — the older Entry sits above the newer one.
  const bodiesBefore = await entryBodiesInOrder(page);
  expect(bodiesBefore.indexOf(older)).toBeLessThan(bodiesBefore.indexOf(newer));

  // The server never sets `created_at` on an UPDATE (only `body`,
  // `deleted_at` and a reassigned `seq` — server/src/sync.rs's
  // `insert_entries`), which is what CONTEXT.md's "editing an Entry does
  // not move it in History" actually rests on. `seq` jumping to the head
  // of the log is exactly the kind of change that WOULD move the row if
  // anything here ordered by `seq` rather than `created_at` — that's the
  // failure mode this test is worth having on screen, not just in the
  // server's own tests.
  const editedOlder = uniqueEntryBody("position-older-edited");
  await editEntryViaMenu(page, older, editedOlder);
  await expect(page.getByText(editedOlder)).toBeVisible();

  const bodiesAfter = await entryBodiesInOrder(page);
  expect(bodiesAfter.indexOf(editedOlder)).toBeLessThan(bodiesAfter.indexOf(newer));
});

test("an edit survives a reload — it lives in the local store, not just React state", async ({
  page,
}) => {
  const original = uniqueEntryBody("edit-reload-original");
  const edited = uniqueEntryBody("edit-reload-edited");

  await page.goto("/composer");
  await sendEntry(page, original);
  await editEntryViaMenu(page, original, edited);
  await expect(page.getByText(edited)).toBeVisible();

  await page.reload();

  await expect(page.getByText(edited)).toBeVisible();
  await expect(page.getByText(original)).toHaveCount(0);
});

test("a delete survives a reload — the tombstone persisted, the Entry does not come back", async ({
  page,
}) => {
  const body = uniqueEntryBody("delete-reload");

  await page.goto("/composer");
  await sendEntry(page, body);
  await deleteEntryViaMenu(page, body);
  await expect(page.getByText(body)).toHaveCount(0);

  await page.reload();

  await expect(page.getByText(body)).toHaveCount(0);
});

// Issue #82 removed the two Undo tests that used to live here ("Undo works
// after the delete has already reached the Server, and converges on both
// Devices" and "Undo restores a deleted Entry, and it stays restored after
// sync settles") along with the feature itself: the Undo toast and its
// restore mutation are gone from use-history.ts, replaced by the confirm
// dialog `deleteEntryViaMenu` (helpers.ts) now accepts on every delete in this
// file. There is nothing left for those two tests to exercise — the "revive
// under a new id because the Server's delete guard is terminal" reasoning
// they proved is recorded instead as a comment on use-history.ts's
// `removeEntry`, for whoever next reaches for a restore path and needs to
// know why one isn't there.
//
// THE IMPORTANT ONE. This is the convergence guarantee that lets ADR 0028
// have no conflict-resolution machinery at all: delete is terminal,
// enforced as a `where entries.deleted_at is null` guard on the write
// itself (server/src/sync.rs's `insert_entries`), not as policy code
// anywhere that has to ask "was this deleted after my edit was made." An
// offline Device holding a stale copy that gets deleted elsewhere, and
// that then pushes an edit to it, must find its own push a no-op and
// converge to deleted on its very next pull — never resurrect what every
// other Device has already agreed is gone.
test("delete is terminal — a straggler edit from an offline Device cannot resurrect it", async ({
  browser,
}) => {
  const devices = await openTwoDevices(browser);
  const { deviceA, pageA, pageB } = devices;

  const original = uniqueEntryBody("terminal-original");
  await sendEntry(pageA, original);
  await expect(pageB.getByText(original)).toBeVisible({ timeout: 20_000 });

  // B already has it via sync, so it's on the Server by now — capture its
  // id while `original` still identifies it (a delete blanks `body`
  // server-side, waitForEntryId's own doc comment) so the tombstone below
  // can be confirmed by id instead of guessed at with a fixed sleep.
  const originalId = await waitForEntryId(original, SERVER_A_DATABASE);

  await deviceA.setOffline(true);

  // Queued locally on A — cannot push while offline.
  const staleEdit = uniqueEntryBody("terminal-stale-edit");
  await editEntryViaMenu(pageA, original, staleEdit);
  await expect(pageA.getByText(staleEdit)).toBeVisible();

  // B deletes the same Entry while A is unreachable, and that delete needs
  // to actually commit and be the Server's only truth about this Entry
  // before A ever gets a chance to push against it — polled for directly
  // (issue #112) rather than assumed after a fixed sleep.
  await deleteEntryViaMenu(pageB, original);
  await expect(pageB.getByText(original)).toHaveCount(0);
  await waitForTombstone(originalId, SERVER_A_DATABASE);

  await deviceA.setOffline(false);

  // A's queued edit matches no row once it reaches the Server (the guard
  // excludes the tombstoned row), so it no-ops; A's next pull then returns
  // the tombstone under the ordinary sync path, same as any other change.
  await expect(pageA.getByText(staleEdit)).toHaveCount(0, { timeout: 20_000 });
  await expect(pageA.getByText(original)).toHaveCount(0);
  await expect(pageB.getByText(original)).toHaveCount(0);
  await expect(pageB.getByText(staleEdit)).toHaveCount(0);

  // Several more sync rounds — this must be a stable, converged state, not
  // one that flickers back if this were flaky. There's no positive
  // condition to poll for here (the point is that nothing changes), so
  // this stays a fixed wait, sized off the real poll interval rather than
  // a bare guess.
  await pageA.waitForTimeout(SYNC_TICK_MS + 3_000);
  await expect(pageA.getByText(staleEdit)).toHaveCount(0);
  await expect(pageA.getByText(original)).toHaveCount(0);
  await expect(pageB.getByText(staleEdit)).toHaveCount(0);
  await expect(pageB.getByText(original)).toHaveCount(0);

  await closeDevices(devices);
});

test("Search reflects an edited body — the new text is found, the old text is not", async ({
  page,
}) => {
  const original = uniqueEntryBody("search-edit-original");
  const edited = uniqueEntryBody("search-edit-edited");

  await page.goto("/composer");
  await sendEntry(page, original);
  await editEntryViaMenu(page, original, edited);
  await expect(page.getByText(edited)).toBeVisible();

  // Editing an Entry re-indexes it (sqlite-entry-store.ts's `edit()` calls
  // `reindexFromCurrentState`) rather than leaving a stale entries_fts row
  // pointing at the old body around to keep matching searches it no
  // longer should.
  await page.getByRole("button", { name: "Search History" }).click();
  const search = page.getByRole("searchbox", { name: "Search History" });

  // Issue #112: this briefly carried a 30s override and a theory that it
  // was queued behind the ambient sync loop's tick in the single SQLite Web
  // Worker every page shares (sqlite-worker.web.ts). That theory didn't
  // survive the actual fix: scripts/e2e-server.sh/-b.sh were running debug
  // builds, and two debug-profile Rust servers under this suite's own
  // 4-way parallel load were enough CPU pressure to occasionally starve
  // this page's own event loop past 15s. Switched to `--release` there
  // instead of raising this timeout further, and four consecutive runs
  // (one under deliberate extra load) never saw this assertion take more
  // than ~2.5s — back to the suite's ordinary default.
  await search.fill("search-edit-edited");
  await expect(page.getByText(edited)).toBeVisible();

  await search.fill("search-edit-original");
  await expect(page.getByText(edited)).toHaveCount(0);
  await expect(page.getByText("No matching Entries.")).toBeVisible();
});

// Exercises the hover affordance from the pointer side, in a real browser
// rather than jsdom — the buttons issue #78 put on each row sit behind
// `@media (hover: hover)` and are `opacity-0` until the row is hovered, and
// neither of those is something jsdom evaluates. Reflection's Grounding
// disclosure renders EntryRow with no `actions` prop at all (see
// entry-row.tsx), so this is also what protects that default: a History row
// must reveal Edit and Delete on hover, or the whole feature is invisible in
// the browser real users point at it with.
test("hovering a History row reveals Edit and Delete", async ({ page }) => {
  const body = uniqueEntryBody("hover-actions-smoke");

  await page.goto("/composer");
  await sendEntry(page, body);

  const row = entryRow(page, body);
  await row.hover();

  await expect(row.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Delete" })).toBeVisible();
});
