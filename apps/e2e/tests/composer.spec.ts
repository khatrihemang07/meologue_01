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

/**
 * The regression this exists for was invisible to every other test here,
 * because all of them stop at ONE checkbox.
 *
 * `listItemNodeView`'s task branch (composer-editor.ts) used to call
 * `dom.insertBefore(checkbox, contentDOM)` without first making sure
 * `contentDOM` was inside `dom`. On the first task item that is harmless —
 * it is built by converting a list item that already had its content
 * attached — but Enter carries `checked` onto a BRAND NEW item, whose
 * NodeView renders before anything has attached it. `insertBefore` then
 * threw, after `dom.className` had already been set, leaving an `<li>`
 * wearing the task class (so `list-none`, so no bullet) with neither a
 * checkbox nor a content wrapper.
 *
 * The visible effect was that a checklist of more than one item could not
 * be written at all: the second line was neither a task nor a bullet. It
 * was found on a physical Android device, not by any test — the same way
 * ADR 0036 records its own floated-clock defect being found.
 */
test("a checklist keeps its checkboxes past the first item", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();

  await editor.pressSequentially("- [ ] call mum");
  await page.keyboard.press("Enter");
  await editor.pressSequentially("buy milk");
  await page.keyboard.press("Enter");
  await editor.pressSequentially("book dentist");

  // Every item is a task, not just the one the input rule ran on.
  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(editor.locator("li")).toHaveCount(3);

  // Each checkbox is independently operable, which the broken markup could
  // not be — the second and third items had no checkbox to click at all.
  const boxes = editor.locator('input[type="checkbox"]');
  await boxes.nth(1).click();
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(boxes.nth(2)).not.toBeChecked();

  // And the marker characters never reappear on any line.
  await expect(editor).not.toContainText("[");
});

test("Enter on an empty task item leaves the list without stranding an item", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();

  await editor.pressSequentially("- [ ] call mum");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await editor.pressSequentially("after");

  // One task survives; the emptied item is gone rather than left behind as
  // a class-bearing shell, and the following prose is outside the list.
  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(1);
  await expect(editor.locator("li")).toHaveCount(1);
  await expect(editor.locator("ul + p")).toHaveText("after");
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

// Regression test for #155 follow-up: typing a Reference by hand, without
// ever opening the `[[` picker's dropdown, used to leave it as inert
// paragraph text — `entry-document.ts`'s `escapeUserText` then escaped the
// `[[` on Send (protecting the round-trip fixpoint for ordinary prose), so
// a hand-typed Reference could never become a chip. `composer-editor.ts`'s
// `referenceInputRule` fixes this: it recognises a completed `[[…]]` the
// same way the picker and `insertAtCursor` already do — reusing
// `parseReferenceDate`/`parseReferenceEntryId` (inline-markdown.ts), the
// SAME validation the reader's own parse path uses — so a hand-typed
// Reference becomes a live node the instant its `]]` completes it.
test("a hand-typed Reference becomes a live node and survives Send as a chip", async ({ page }) => {
  const target = uniqueEntryBody("hand-typed-ref-target");
  await page.goto("/composer");
  await sendEntry(page, target);
  const targetId = await waitForEntryId(target, SERVER_A_DATABASE);

  const editor = composerField(page);
  await editor.click();
  // No picker involved: `[[e:<uuid>]]` is typed in full, character by
  // character, exactly as a person would type it from memory.
  await editor.pressSequentially(`see [[e:${targetId}]]`);

  // Still inside the Composer, before Send: a live, non-editable Reference
  // node exists — its own NodeView (`referenceNodeView`) is what renders
  // `[[e:<uuid>]]` on screen, per ADR 0042 ("the characters the user
  // typed, not interactive" — a chip deliberately shows its `raw` text
  // rather than a resolved label). That is the distinction that matters:
  // before this fix, the SAME on-screen characters were inert paragraph
  // text with no node behind them at all, which `escapeUserText`
  // (entry-document.ts) then escaped on Send so it could never resolve.
  const reference = editor.locator("[data-reference]");
  await expect(reference).toBeVisible();
  await expect(reference).toHaveAttribute("contenteditable", "false");
  await expect(reference).toHaveText(`[[e:${targetId}]]`);

  await page.getByRole("button", { name: "Send" }).click();

  // After Send, History renders it as a real chip — the same
  // `/composer?e=<id>` link a picker-inserted or `insertAtCursor`-inserted
  // Reference produces (entry-row.tsx).
  const chip = page.locator(`a[href="/composer?e=${targetId}"]`);
  await expect(chip.first()).toBeVisible();
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
