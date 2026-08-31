import { expect, test } from "@playwright/test";
import { SERVER_A_DATABASE } from "../servers";
import {
  composerField,
  editEntryViaMenu,
  entryRow,
  entrySeq,
  sendEntry,
  uniqueEntryBody,
  waitForEntryId,
} from "./helpers";

/**
 * Issue #155: the Composer holds a live ProseMirror document instead of a
 * `<textarea>` string, so formatting shows as it's typed rather than only
 * after Send. Everything here needs a real browser — composer.tsx's own
 * module comment records why jsdom cannot drive a ProseMirror `EditorView`
 * at all (no `Range`, no `Selection`, no meaningful `getBoundingClientRect`)
 * — and this is where that logic actually gets exercised, not in vitest.
 *
 * `.pressSequentially`, not `.fill()`: input rules fire off real
 * `beforeinput`/`handleTextInput` events per character, and a bulk DOM
 * write bypasses that path entirely (verified live — a `.fill()`'d
 * `**bold**` stays four literal asterisks around plain text). See
 * `composerField`'s own comment (helpers.ts) for the fuller version of this
 * same reasoning, which is why `sendEntry`/`editEntryViaMenu` themselves
 * switched to the same technique for every other spec in this suite.
 */

test("typing consumes the marker characters and applies the formatting", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("**bold** *italic* `code`");

  // The marker characters themselves are gone — this is the ticket's own
  // headline acceptance criterion, checked the strongest way available:
  // the literal asterisk/backtick characters must not exist anywhere in
  // the field's rendered text, not merely "some strong element exists
  // somewhere on the page."
  await expect(editor).not.toContainText("*");
  await expect(editor).not.toContainText("`");

  await expect(editor.locator("strong")).toHaveText("bold");
  await expect(editor.locator("em")).toHaveText("italic");
  await expect(editor.locator("code")).toHaveText("code");
});

// Regression coverage for a real defect this ticket's own manual
// verification caught (not any unit test — jsdom can't run this at all):
// input rules re-run on EVERY keystroke, not just the fully-typed string,
// so typing "**bold**" one character at a time briefly passes through the
// state "**bold*" — one closing asterisk short — which a naive em pattern
// genuinely matches, turning "bold" italic before the second closing `*`
// ever arrives to make it bold. composer-editor.ts's em rule guards
// against exactly this with a negative lookbehind; this test is what
// would catch it coming back.
test("bold and italic stay distinct even though ** shares a character with *", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("**strong** then *em*");

  await expect(editor.locator("strong")).toHaveText("strong");
  await expect(editor.locator("em")).toHaveText("em");
});

test("a bullet marker starts a list; Enter gives the next item; Enter on an empty item leaves the list", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- first item");
  await editor.press("Enter");
  await editor.pressSequentially("second item");

  await expect(editor.locator("ul li")).toHaveCount(2);
  await expect(editor.locator("ul li").nth(0)).toHaveText("first item");
  await expect(editor.locator("ul li").nth(1)).toHaveText("second item");

  // Enter on the empty item just opened escapes the list (splitListItem
  // bails on an empty top-level item; liftListItem then runs) rather than
  // adding a third, empty bullet.
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially("back to prose");

  await expect(editor.locator("ul li")).toHaveCount(2);
  await expect(editor.locator("p", { hasText: "back to prose" })).toBeVisible();
});

test("a numbered marker starts an ordered list", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("1. first");
  await editor.press("Enter");
  await editor.pressSequentially("second");

  await expect(editor.locator("ol li")).toHaveCount(2);
  await expect(editor.locator("ol li").nth(0)).toHaveText("first");
  await expect(editor.locator("ol li").nth(1)).toHaveText("second");
});

test("- [ ] starts a checkbox, and it can be ticked while composing", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- [ ] call mum");

  const checkbox = editor.locator('input[type="checkbox"]');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  // The marker characters ("[ ]") themselves are gone, replaced by the
  // control — the same "never leave the syntax on screen" rule the bold/
  // italic/code test above checks.
  await expect(editor).not.toContainText("[");

  await checkbox.click();
  await expect(checkbox).toBeChecked();
});

test("Shift+Enter never sends, on this build the same as every other", async ({ page }) => {
  const firstLine = uniqueEntryBody("composer-shift-enter-one");
  const secondLine = uniqueEntryBody("composer-shift-enter-two");
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(firstLine);
  await editor.press("Shift+Enter");
  await editor.pressSequentially(secondLine);

  // Still in the field, now two paragraphs — nothing was sent. This suite
  // runs its specs sequentially against one shared server (playwright.config.ts's
  // own `fullyParallel: false`), so History already carries whatever every
  // earlier spec in this run sent — the two lines' own unique bodies are
  // what a "nothing sent" check has to name, not History's total count.
  // Scoped to a History bubble specifically (not a bare `getByText`, which
  // would also match the two lines still sitting, unsent, in the field
  // itself).
  await expect(editor.locator("p")).toHaveCount(2);
  await expect(page.locator('[data-slot="bubble-body"]', { hasText: firstLine })).toHaveCount(0);
  await expect(page.locator('[data-slot="bubble-body"]', { hasText: secondLine })).toHaveCount(0);
});

test("the submit chord still sends, unchanged", async ({ page }) => {
  const body = uniqueEntryBody("composer-chord");
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(body);
  // "web" mode (this suite's own build — scripts/e2e-server.sh) accepts
  // either modifier (submit-chord.ts); ControlOrMeta is Playwright's own
  // cross-platform stand-in for whichever one this OS actually has.
  await editor.press("ControlOrMeta+Enter");

  await expect(page.getByText(body)).toBeVisible();
  // Cleared, not literally empty text — an empty document still renders
  // composer-editor.ts's own placeholder widget, so "What's on your mind?"
  // showing again is exactly what "the field went back to empty" looks
  // like (composer.tsx's own `PLACEHOLDER` constant).
  await expect(editor).toContainText("What's on your mind?");
});

test("the [[ picker offers a recent day, and choosing one inserts a live Reference", async ({
  page,
}) => {
  const body = uniqueEntryBody("composer-picker-anchor");
  await page.goto("/composer");
  await sendEntry(page, body);

  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("see [[");

  const listbox = page.getByRole("listbox", { name: "Days" });
  await expect(listbox).toBeVisible();
  const option = page.getByRole("option").first();
  await expect(option).toBeVisible();
  await editor.press("Enter");

  await expect(listbox).toBeHidden();
  // A live Reference node, not literal bracket text — non-editable, and
  // carrying the underline style entry-row.tsx's own read-mode chip uses
  // (composer-editor.ts's `referenceNodeView`).
  const reference = editor.locator("[data-reference]");
  await expect(reference).toBeVisible();
  await expect(reference).toHaveAttribute("contenteditable", "false");
});

// ADR 0044's own load-bearing rule: converting a document back to text
// normalizes it, so an Entry opened merely to be re-read must never be
// rewritten, must never Sync, and must never mark a Digest stale. `seq` is
// reassigned on every write (ADR 0028) and never merely on a read, so it is
// the strongest available proof that closing an unedited Entry wrote
// nothing at all — a passing UI assertion alone (the row still reads the
// same) would also pass for a version that quietly rewrote identical bytes.
test("opening an Entry and closing it unchanged writes nothing — ADR 0044's dirty-only commit", async ({
  page,
}) => {
  const body = uniqueEntryBody("composer-dirty-only");
  await page.goto("/composer");
  await sendEntry(page, body);

  const id = await waitForEntryId(body, SERVER_A_DATABASE);
  const seqBeforeEdit = entrySeq(id, SERVER_A_DATABASE);
  expect(seqBeforeEdit).toBeDefined();

  const row = entryRow(page, body);
  await row.hover();
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText("Editing Entry")).toBeVisible();

  // Send with nothing changed — ADR 0044's rule says this is a Cancel in
  // every way that matters, not a no-op commit of identical bytes.
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Editing Entry")).toHaveCount(0);
  await expect(page.getByText(body)).toBeVisible();

  // "Prove nothing happened" needs a real wait, not just an immediate
  // re-check (helpers.ts's own SYNC_TICK_MS comment) — a stale `seq` a
  // moment later is only convincing once enough time has passed that a
  // real write, had one occurred, would already have reached the Server.
  await page.waitForTimeout(1_500);
  const seqAfterUnchangedEdit = entrySeq(id, SERVER_A_DATABASE);
  expect(seqAfterUnchangedEdit).toBe(seqBeforeEdit);

  // The contrast case, in the same test rather than a separate one: a
  // REAL edit right after DOES move `seq` — proving the check above isn't
  // passing merely because nothing in this test ever moves `seq` at all.
  await editEntryViaMenu(page, body, `${body} edited`);
  await expect(page.getByText(`${body} edited`)).toBeVisible();
  await expect
    .poll(() => entrySeq(id, SERVER_A_DATABASE), { timeout: 20_000 })
    .not.toBe(seqAfterUnchangedEdit);
});
