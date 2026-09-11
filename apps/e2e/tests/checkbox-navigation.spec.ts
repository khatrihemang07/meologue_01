import { SERVER_A_DATABASE } from "../servers";
import { expect, test } from "./fixtures";
import { entryRow, sendEntry, uniqueEntryBody, waitForTaskUncompleted } from "./helpers";

/**
 * Issue #231, ADR 0074: neither checkbox shape in History still ticks
 * anything. A *bare* `- [ ]` line (no `[[task:id|label]]` mark behind it)
 * renders permanently disabled — it has no Task to open, so there is
 * nothing this suite could click it to prove — and a *referenced* line's
 * checkbox, once it has one, now opens the Task instead of completing it
 * directly (ADR 0043's original "a checkbox is clickable, and ticking it
 * splices the stored string," the second half ADR 0074 supersedes here,
 * having already retired the bare-checkbox half in its first cut). Todo
 * remains the single place completion happens; History is for reading and
 * redirection.
 *
 * Both tests below Send a bare `- [ ]` line and let it render: Promotion
 * (issue #173, ADR 0048) turns a bare checkbox into a live
 * `[[task:id|label]]` reference synchronously, before the Send mutation
 * even settles, so the row this suite ever gets to click is already the
 * *referenced* shape — `composer.spec.ts`'s own "editing a Sent checkbox
 * line" test (issue #177) already establishes that same fact for the edit
 * path. `entryRow` (helpers.ts) scopes every assertion to the thread's own
 * bubble, not today's Day block row the same Send also produces (issue
 * #174) — the two are different elements rendering related but distinct
 * state, and a bare text match would otherwise resolve both.
 */

test("clicking a referenced checkbox's own words in History opens its Task over the Composer, leaving the Entry untouched", async ({
  page,
}) => {
  const body = uniqueEntryBody("history-checkbox-opens-task");
  await page.goto("/composer");
  await sendEntry(page, `- [ ] ${body}`);

  const row = entryRow(page, body);
  await expect(row).toBeVisible();

  // The referenced line's own words render as a <button> (issue #181,
  // entry-row.tsx's TaskReferenceItem), a separate control from the
  // checkbox <input> beside it — since issue #231/ADR 0074, clicking
  // either opens the Task (the second test below covers the box).
  await row.getByRole("button", { name: body, exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue(body);
  // Never left the Composer for a separate Todo route (composer-page.tsx's
  // own `?task=` overlay, the same door the Day block's own "opens" test
  // already proves) — opening a Task from History is navigation *within*
  // the Composer, not away from it.
  expect(page.url()).toContain("/composer");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The Entry itself was never touched: its row still reads exactly as
  // Sent, and its checkbox is still unchecked — opening a Task is a read,
  // not a write to the Entry.
  await expect(row).toContainText(body);
  await expect(row.getByRole("checkbox")).not.toBeChecked();
});

test("clicking a referenced checkbox's own box in History opens its Task instead of completing it", async ({
  page,
}) => {
  const body = uniqueEntryBody("history-checkbox-opens-not-ticks");
  await page.goto("/composer");
  await sendEntry(page, `- [ ] ${body}`);

  const row = entryRow(page, body);
  await expect(row).toBeVisible();

  // The checkbox <input> itself, not the words beside it (the first test
  // above) — issue #231/ADR 0074's whole point is that both controls now
  // do the identical thing.
  await row.getByRole("checkbox").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue(body);
  expect(page.url()).toContain("/composer");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Never ticked: the row's own checkbox still reads unchecked — a
  // checkbox `<input>`'s own native check/uncheck is prevented before it
  // can happen (`TaskReferenceItem`'s own `handleCheckboxClick`,
  // entry-row.tsx) — and the Server's own `tasks` row for this content
  // still carries no completion either, the same "wait for the Server to
  // agree" discipline `waitForTaskUncompleted`'s own doc comment gives for
  // an un-tick, run here to confirm a tick never reached it in the first
  // place.
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await waitForTaskUncompleted(body, SERVER_A_DATABASE);
});
