import type { Locator, Page } from "@playwright/test";
import { SERVER_A_DATABASE } from "../servers";
import { expect, test } from "./fixtures";
import {
  advanceDateByDays,
  composerField,
  editEntryViaMenu,
  entryRow,
  entrySeq,
  installDateOffset,
  openDestination,
  sendEntry,
  uniqueEntryBody,
  waitForEntryId,
  waitForTaskCompleted,
  waitForTaskUncompleted,
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

/**
 * Move the caret to the start of its line AND wait for the editor to know
 * it. See the long note at the Backspace test's own call site for why the
 * second half is load-bearing rather than a sleep — in short, a caret move
 * reaches ProseMirror's state a task later than the keypress that caused
 * it, and a command reading the selection in between gets the old one.
 */
async function caretToStartOfLine(page: Page, editor: Locator): Promise<void> {
  await editor.press("Home");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const selection = window.getSelection();
        return selection === null ? -1 : selection.anchorOffset;
      }),
    )
    .toBe(0);
  // One more turn of the event loop after the DOM selection has settled, so
  // DOMObserver's flush of that `selectionchange` has actually run.
  await page.waitForTimeout(50);
}

/**
 * Presses Enter until the field holds exactly `target` `<p>` elements —
 * issue #214's own soft-break-migration test needs several Enters typed
 * back to back with nothing in between, and `caretToStartOfLine`'s own
 * comment (above) already names the general hazard: a keypress fired while
 * ProseMirror's DOMObserver hasn't yet flushed the previous one's mutation
 * is simply lost, so a fixed count of `.press("Enter")` calls can silently
 * under-count. Under ADR 0069 Enter always SPLITS a block rather than
 * inserting a `\n` inside one, so what needs polling is the paragraph
 * COUNT, not a trailing run of `\n` characters the way this helper's own
 * pre-ADR-0069 shape used to check for — the identical "poll and retry the
 * action itself," not just the assertion, idiom the ArrowLeft test above
 * this one already uses for the same class of race.
 */
async function pressEnterUntilBlockCount(editor: Locator, target: number): Promise<void> {
  await expect
    .poll(async () => {
      const count = await editor.locator("p").count();
      if (count < target) {
        await editor.press("Enter");
      }
      return count;
    })
    .toBe(target);
}

test("typing consumes the marker characters and applies the formatting", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("**bold** *italic* `code` ~~struck~~");

  // The marker characters themselves are gone — this is the ticket's own
  // headline acceptance criterion, checked the strongest way available:
  // the literal asterisk/backtick/tilde characters must not exist anywhere
  // in the field's rendered text, not merely "some strong element exists
  // somewhere on the page."
  await expect(editor).not.toContainText("*");
  await expect(editor).not.toContainText("`");
  await expect(editor).not.toContainText("~");

  await expect(editor.locator("strong")).toHaveText("bold");
  await expect(editor.locator("em")).toHaveText("italic");
  await expect(editor.locator("code")).toHaveText("code");
  await expect(editor.locator("s")).toHaveText("struck");
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

/**
 * Issue #158: `.ProseMirror` carried no `white-space` rule of its own, so
 * the field behaved like ordinary prose — plain `white-space: normal` is
 * free to collapse a run of spaces down to one, and a browser can
 * substitute U+00A0 in for a literal space to keep it from disappearing
 * rather than leaving the field showing what was actually typed
 * (ProseMirror upstream issues #981 and #598 — WebKit does this far more
 * eagerly than Chromium). `entry-prose.tsx`'s read side has always
 * rendered with `whitespace-pre-wrap`, so before the CSS fix the Composer
 * could show something different from both what was typed and what
 * History would go on to show once Sent — the exact "the editor lies
 * about what you will get" complaint issue #155 exists to remove,
 * surviving here in a corner that change never reached.
 *
 * `.textContent()`, not a Playwright text matcher: `toHaveText`/
 * `getByText`/`hasText` all normalise internal whitespace before
 * comparing, which would hide exactly the defect this test exists to
 * catch. `waitForEntryId` resolving on the exact stored `body` is the same
 * idea one layer down, at the Server rather than the DOM.
 */
test("two consecutive spaces survive typing, Send, and rendering in History", async ({ page }) => {
  const marker = uniqueEntryBody("composer-whitespace-pair");
  const body = `${marker} two  spaces here`;
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(body);

  await expect.poll(() => editor.locator("p").textContent()).toBe(body);

  await page.getByRole("button", { name: "Send" }).click();
  const id = await waitForEntryId(body, SERVER_A_DATABASE);
  expect(id).toBeDefined();

  const bubble = page.locator('[data-slot="bubble-body"]', { hasText: marker });
  await expect.poll(() => bubble.textContent()).toBe(body);
});

/**
 * The trailing-space half of the same defect, checked only "on screen" per
 * issue #158's own acceptance criteria — not through Send. A trailing
 * space at the very end of the WHOLE document is deliberately stripped by
 * `normalizeEntryBody` (entry-text.ts) when a brand-new Entry is sent
 * (`sendEntry`, use-history.ts), the same as any other leading/trailing
 * whitespace on a draft. That trim is existing, intentional behaviour this
 * ticket does not touch, not a regression of it — so this test stops at
 * proving the field itself never drops the space while it's being typed,
 * which is the part `.ProseMirror`'s missing `white-space` rule broke.
 */
test("a trailing space at the end of a line survives on screen", async ({ page }) => {
  const marker = uniqueEntryBody("composer-whitespace-trailing");
  const body = `${marker} trailing `;
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(body);

  await expect.poll(() => editor.locator("p").textContent()).toBe(body);
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

/**
 * Issue #234's own second reported defect, named directly in its brief:
 * "Enter/Backspace on an empty list item should close the list... The code
 * claims to do this and is tested — but only for bullet lists and
 * checklists; there is no ordered-list case anywhere." This is that
 * missing case — mirrors "a bullet marker starts a list; Enter gives the
 * next item; Enter on an empty item leaves the list" (above) and "Enter on
 * an empty task item leaves the list without stranding an item" (below),
 * against an ordered list instead.
 *
 * Reproduced against a numbered list first, before writing this test: the
 * same `chainCommands(splitListItemUnchecked, outdent.run, splitBlock)`
 * `listKeymap` (composer-editor.ts) binds Enter to has no list-kind
 * branching in it at all — `splitListItem`'s own empty-top-level-item bail
 * (prosemirror-schema-list) and `outdent.run`'s `liftListItem` fire
 * identically for a `bullet_list` and an `ordered_list` alike — so the
 * defect the issue describes did NOT reproduce: this asserts the already-
 * correct behaviour, it does not fix anything.
 */
test("a numbered marker starts an ordered list; Enter on an empty top-level item leaves the list", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("1. first item");
  await editor.press("Enter");
  await editor.pressSequentially("second item");

  await expect(editor.locator("ol li")).toHaveCount(2);
  await expect(editor.locator("ol li").nth(0)).toHaveText("first item");
  await expect(editor.locator("ol li").nth(1)).toHaveText("second item");

  // Enter on the empty item just opened escapes the list — the ordered-list
  // analogue of the bullet-list case above.
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially("back to prose");

  await expect(editor.locator("ol li")).toHaveCount(2);
  await expect(editor.locator("p", { hasText: "back to prose" })).toBeVisible();
});

/**
 * The other half of the same acceptance criterion: "Enter on an empty
 * nested item outdents one level and stays in the list" — reproduced
 * against a numbered list first, the same way as the top-level case just
 * above, and found to already work correctly (`outdent.run` is the
 * identical `liftListItem(listItemNodeType)` regardless of which list
 * kind the item sits in). This pins down the already-correct behaviour,
 * not a fix.
 */
test("Enter on an empty nested ordered item outdents one level and stays in the list", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("1. top");
  await editor.press("Enter");
  await editor.press("Tab");
  await editor.pressSequentially("nested");
  await editor.press("Enter");
  await expect(editor.locator("ol ol > li")).toHaveCount(2);

  // The freshly opened second nested item is empty; Enter on it outdents
  // one level rather than leaving the list entirely.
  await editor.press("Enter");
  await editor.pressSequentially("outdented");

  await expect(editor.locator("ol ol > li")).toHaveCount(1);
  await expect(editor.locator("ol ol > li").first()).toHaveText("nested");
  // Scoped to the ROOT list's own direct children — a bare "ol > li"
  // selector matches ANY `<li>` that is some `<ol>`'s direct child,
  // regardless of which `<ol>`, so it would also match "nested" (a direct
  // child of the inner, nested `<ol>`) and over-count here.
  const rootItems = editor.locator("ol").first().locator("> li");
  await expect(rootItems).toHaveCount(2);
  await expect(rootItems.nth(1)).toHaveText("outdented");
});

/**
 * ADR 0072 (issue #230, restated by ADR 0069/issue #234's own "also in
 * scope" list): the two shipped UpNote platforms disagree on multi-line
 * paste — macOS joins pasted lines into one `<br>`-separated block, Android
 * produces separate blocks. This repo deliberately follows Android:
 * "pasted lines become real blocks with no backslash noise in storage."
 * Verified here to already hold with no dedicated paste-handling code of
 * this repo's own: `EditorView`'s default plain-text clipboard-to-document
 * conversion (no `clipboardTextParser`/`transformPastedText` prop is set
 * anywhere in `composer.tsx`) already puts each line of a plain-text paste
 * into its own textblock, matching the chosen behaviour without this
 * ticket adding anything.
 */
test("multi-line paste produces separate blocks, not one soft-broken block (ADR 0072's Android choice)", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();

  await page.evaluate(() =>
    navigator.clipboard.writeText("pasted line one\npasted line two\npasted line three"),
  );
  await page.keyboard.press("ControlOrMeta+v");

  await expect(editor.locator("p")).toHaveCount(3);
  await expect(editor.locator("p").nth(0)).toHaveText("pasted line one");
  await expect(editor.locator("p").nth(1)).toHaveText("pasted line two");
  await expect(editor.locator("p").nth(2)).toHaveText("pasted line three");
});

/**
 * Issue #161: `*` is a bullet marker to `parseEntryMarkdown` (CommonMark's
 * own bullet alphabet is `-`/`+`/`*`, and `entryParser` uses the stock
 * `@lezer/markdown` bullet parser unmodified) exactly as much as `-` and
 * `+` already are, but `bulletListInputRule` only recognised the latter
 * two before this ticket. Verified on a real macOS build, not just in this
 * suite: typing `* milk` left the literal text `* milk` on screen, and
 * only became a bullet the instant it was Sent — `escapeUserText`
 * (entry-document.ts) has always escaped a leading `*` to `\*`, which was
 * silently carrying the weight of this rule's own gap the whole time.
 */
test("a * marker starts a bullet list, the same as - and +", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("* first");
  await editor.press("Enter");
  await editor.pressSequentially("second");

  await expect(editor.locator("ul li")).toHaveCount(2);
  await expect(editor.locator("ul li").nth(0)).toHaveText("first");
  await expect(editor.locator("ul li").nth(1)).toHaveText("second");
  // The marker itself never survives on screen — the same "no leftover
  // syntax" check every other list/mark test in this file makes.
  await expect(editor).not.toContainText("*");
});

/**
 * Issue #161: CommonMark's ordered-list delimiter is `.` OR `)` — the same
 * `orderedListStart` comment (inline-markdown.ts) that already says
 * "`1.` and `1)` both give 1" — but `orderedListInputRule` only recognised
 * `.` before this ticket. Verified on a real macOS build the same way `*`
 * was: `1) alpha` stayed literal the whole time it was being typed.
 */
test("a 1) marker starts an ordered list, the same as 1.", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("1) first");
  await editor.press("Enter");
  await editor.pressSequentially("second");

  await expect(editor.locator("ol li")).toHaveCount(2);
  await expect(editor.locator("ol li").nth(0)).toHaveText("first");
  await expect(editor.locator("ol li").nth(1)).toHaveText("second");
  await expect(editor).not.toContainText(")");
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
 * Issue #161's one-step checklist trigger: `[] ` at the start of a plain
 * paragraph creates a checklist item directly, with no `- ` step in
 * between — UpNote's own trigger (verified in its shipped bundle). This is
 * distinct from `checkboxInputRule`'s existing two-step `- ` then `[ ] `
 * upgrade, which the earlier test in this file still covers unchanged.
 */
test("[] starts a checklist item directly, with no bullet step first", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("[] call mum");

  const checkbox = editor.locator('input[type="checkbox"]');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(editor).not.toContainText("[");
});

test("[x] and [X] start a checked checklist item directly", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("[x] first");
  // Since issue #210, this Enter itself yields an UNCHECKED second item
  // (`splitListItemUnchecked`, composer-commands.ts) — "first" was a done
  // task, and continuing it must not silently mint a second done Task.
  // The typed "[X] " that follows is what re-checks it, via the ORDINARY
  // `checkboxInputRule` a person typing that marker on any line would
  // trigger. So this test now exercises two independent mechanisms in
  // sequence (split-then-uncheck, then a fresh input rule re-checking it),
  // not one — and still ends up checked either way, which is why it still
  // passes unchanged.
  await editor.press("Enter");
  await editor.pressSequentially("[X] second");

  const boxes = editor.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(editor).not.toContainText("[");
});

/**
 * Issue #210: continuing a DONE checklist item must not mint a second done
 * Task. `splitListItemUnchecked` (composer-commands.ts) has direct unit
 * coverage against a plain `EditorState`; this is the keystroke path
 * itself, through a real `EditorView` and `listKeymap`'s actual `Enter`
 * binding.
 */
test("Enter after a ticked checklist item's text produces an UNticked new item", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("[x] first");
  await editor.press("Enter");
  await editor.pressSequentially("second");

  const boxes = editor.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).not.toBeChecked();
  await expect(editor.locator("li").nth(0)).toHaveText("first");
  await expect(editor.locator("li").nth(1)).toHaveText("second");
});

/**
 * The case `itemAttrs` cannot reach at all (composer-commands.ts's own
 * comment on `splitListItemUnchecked`): `splitListItem` only honours
 * `itemAttrs` when the caret sits at `$from.end()`. Splitting further back
 * takes an entirely different internal path that copies the ORIGINAL
 * item's own type and attrs onto both halves, so this is the case that
 * actually exercises the transaction-patching fix rather than a param
 * `splitListItem` would have handled on its own.
 */
test("Enter in the MIDDLE of a ticked item's text also produces an unticked new item", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("[x] buy milk");
  // Wait for the checklist input rule's transaction to land before moving the
  // caret. Without this the ArrowLefts race it, arrive while the selection is
  // still at the end, and the Enter below becomes an end-of-item split — which
  // still yields two checkboxes, so only the text assertions catch it.
  await expect(editor.locator("li p")).toHaveText("buy milk");
  // Caret starts after "milk"; walk it back to just after "buy", before the
  // space — a mid-text split, not an end-of-item one.
  //
  // ProseMirror does not learn about a caret move from the keypress that caused
  // it: the browser moves the DOM selection, fires `selectionchange`, and
  // DOMObserver flushes that into editor state on a LATER task. A press sent
  // inside that window is simply lost, so a fixed number of ArrowLefts lands the
  // caret at an offset nobody chose. Counting the presses cannot fix that; only
  // re-pressing until the caret actually arrives can. `expect.poll` retries the
  // press and re-reads the offset until it reaches the target, so the test
  // asserts the precondition it depends on instead of assuming it.
  const TARGET = "buy".length;
  const caretOffset = () => page.evaluate(() => window.getSelection()?.anchorOffset ?? -1);
  await expect
    .poll(
      async () => {
        const offset = await caretOffset();
        if (offset > TARGET) {
          await editor.press("ArrowLeft");
        }
        return offset;
      },
      { message: "caret never reached the middle of the item's text" },
    )
    .toBe(TARGET);
  await editor.press("Enter");

  const boxes = editor.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  // The first half keeps the original item's own checked state...
  await expect(boxes.nth(0)).toBeChecked();
  // ...only the newly split-off second half is forced back to unchecked.
  await expect(boxes.nth(1)).not.toBeChecked();
  await expect(editor.locator("li").nth(0)).toHaveText("buy");
  await expect(editor.locator("li").nth(1)).toHaveText("milk");
});

/**
 * The regression a STATIC `checked: false` (rather than reading the
 * original item's own state) would cause: Enter on a plain bullet must
 * stay a plain bullet, `checked` left `null` — never promoted to a
 * checkbox just because it went through the same split path a task does.
 */
test("Enter on a plain (non-checkbox) bullet still produces a plain bullet, never minting a checkbox", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- first");
  await editor.press("Enter");
  await editor.pressSequentially("second");

  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(editor.locator("ul > li")).toHaveCount(2);
});

/**
 * The acceptance criterion this ticket is most explicit about for the new
 * trigger: `[] ` only means something at the very START of a block. A
 * checkbox outside a list is not part of this dialect (ADR 0043) any more
 * than it was before this ticket — this rule does not change that, it only
 * adds a faster way to reach the same structure when `[] ` genuinely opens
 * a line.
 */
test("[] mid-line stays literal text, not a checklist item", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("buy milk [] not a checkbox");

  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(editor.locator("p")).toHaveText("buy milk [] not a checkbox");
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

/**
 * Issue #162: nesting already worked in the parser, the schema, the
 * serializer, and the reader — the Composer was the one place it could not
 * be REACHED, because `sinkListItem`/`liftListItem` (prosemirror-schema-
 * list) were registered in composer-commands.ts's own registry but never
 * bound to a key. The next several tests are the keyboard side of that:
 * `Tab`/`Shift-Tab` and their `Ctrl-]`/`Ctrl-[` aliases (`listKeymap()`,
 * composer-editor.ts), and the gated `Backspace` lift beside them. None of
 * this is reachable through jsdom (ADR 0044 — no live `EditorView`), which
 * is why it lives here and not in composer-editor.test.ts.
 */
test("Tab indents a list item, up to three levels deep", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- top");
  await editor.press("Enter");
  await editor.pressSequentially("mid");
  // Sinks "mid" under its preceding sibling "top" — a nested <ul>, one
  // level deep.
  await editor.press("Tab");
  await editor.press("Enter");
  await editor.pressSequentially("deep");
  // "deep" is now "mid"'s own preceding-sibling-less item at "mid"'s
  // depth; sinking it nests it under "mid" in turn — a THIRD <ul>.
  await editor.press("Tab");

  await expect(editor.locator("li")).toHaveCount(3);
  await expect(editor.locator("ul > li", { hasText: "top" })).toHaveCount(1);
  await expect(editor.locator("ul ul > li", { hasText: "mid" })).toHaveCount(1);
  await expect(editor.locator("ul ul ul > li", { hasText: "deep" })).toHaveCount(1);
});

test("Shift-Tab outdents a nested list item back up one level", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- top");
  await editor.press("Enter");
  await editor.pressSequentially("mid");
  await editor.press("Tab");
  await expect(editor.locator("ul ul > li", { hasText: "mid" })).toHaveCount(1);

  await editor.press("Shift+Tab");

  // Back to one flat list — "mid" is a top-level sibling of "top" again,
  // not nested under it.
  await expect(editor.locator("ul ul")).toHaveCount(0);
  await expect(editor.locator("ul > li")).toHaveCount(2);
  await expect(editor.locator("ul > li").nth(1)).toHaveText("mid");
});

/**
 * `Ctrl-]`/`Ctrl-[`, not `Cmd-]`/`Cmd-[`: literal Control on every
 * platform, deliberately (composer-editor.ts's own `listKeymap` comment —
 * `Cmd-]` is already browser-forward navigation on macOS, and Todoist
 * ships `Control+]` everywhere for exactly this reason). Playwright's
 * `BracketRight`/`BracketLeft` key codes are what a physical `]`/`[` key
 * reports regardless of layout-driven shifting, matching the literal
 * `Ctrl-]`/`Ctrl-[` chord `prosemirror-keymap` parses these bindings as.
 */
test("Ctrl-] and Ctrl-[ indent and outdent, the same as Tab and Shift-Tab", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- top");
  await editor.press("Enter");
  await editor.pressSequentially("mid");

  await editor.press("Control+BracketRight");
  await expect(editor.locator("ul ul > li", { hasText: "mid" })).toHaveCount(1);

  await editor.press("Control+BracketLeft");
  await expect(editor.locator("ul ul")).toHaveCount(0);
  await expect(editor.locator("ul > li")).toHaveCount(2);
});

test("Backspace at the very start of a list item lifts it out one level, and out of the list entirely at the top", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- top");
  await editor.press("Enter");
  await editor.pressSequentially("mid");
  await editor.press("Tab");
  await expect(editor.locator("ul ul > li", { hasText: "mid" })).toHaveCount(1);

  // Backspace only lifts at the very START of an item's own paragraph —
  // move there explicitly rather than relying on wherever typing left the
  // caret.
  //
  // `caretToStartOfLine` rather than a bare `press("Home")`, and the wait
  // inside it is not padding. ProseMirror does not learn about a caret move
  // from the keypress that caused it: the browser moves the DOM selection,
  // fires `selectionchange`, and `DOMObserver` flushes that into editor
  // state on a LATER task. Playwright can press the next key inside that
  // window, and then every command in the Backspace chain reads a stale
  // selection — `liftAtStartOfListItem` sees `parentOffset` still at the end
  // of the word, declines, `baseKeymap`'s own chain declines for the same
  // reason, nothing calls `preventDefault`, and the BROWSER performs a
  // native contenteditable Backspace from the real DOM position. That
  // merged the two items' paragraphs into `<p>topmid</p>` — a shape no
  // command here would ever produce. Verified by instrumenting the command
  // and reading the page console: it was invoked with `parentOffset: 3`
  // while the DOM selection was at 0.
  await caretToStartOfLine(page, editor);
  await editor.press("Backspace");

  // Lifted one level, not merged into "top"'s own text: "mid" is once
  // again a top-level sibling of "top", still its own separate item.
  await expect(editor.locator("ul ul")).toHaveCount(0);
  await expect(editor.locator("ul > li")).toHaveCount(2);
  await expect(editor.locator("ul > li").nth(1)).toHaveText("mid");

  // At the top level — no further list to lift into — the same gesture
  // leaves the list entirely, per the ticket's own acceptance criterion:
  // "mid" becomes plain prose after a now single-item list, not merged
  // into "top" and not stranded as an empty item.
  await editor.press("Home");
  await editor.press("Backspace");

  await expect(editor.locator("ul > li")).toHaveCount(1);
  await expect(editor.locator("ul > li").first()).toHaveText("top");
  await expect(editor.locator("ul + p", { hasText: "mid" })).toBeVisible();
});

/**
 * Issue #210: `Backspace` is now `chainCommands(undoInputRule,
 * liftAtStartOfListItem)`, not `liftAtStartOfListItem` alone
 * (`listKeymap`, composer-editor.ts — its own comment there has the full
 * "why `undoInputRule` must run FIRST" reasoning). `undoInputRule`
 * (prosemirror-inputrules) only fires when the IMMEDIATELY PRECEDING
 * transaction was an `InputRule` match, so typing `"- "` — which converts
 * the line into a bullet via a `wrappingInputRule` — leaves exactly that
 * behind for the very next `Backspace` to revert: the literal two
 * characters come back and the list disappears, rather than (as before
 * this ticket) `Backspace` doing nothing at all, since `baseKeymap`'s own
 * Backspace has no character to delete at offset 0 of an otherwise-empty
 * paragraph.
 *
 * jsdom cannot exercise this at all (ADR 0044): `undoInputRule` reads a
 * plugin's OWN state, which only exists after a real dispatch through a
 * mounted `EditorView` — there is no unit-test seam for this half of the
 * ticket, only this one.
 */
test('Backspace right after typing "- " undoes the bullet input rule, restoring the literal text', async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- ");
  await expect(editor.locator("ul > li")).toHaveCount(1);

  await editor.press("Backspace");

  await expect(editor.locator("ul")).toHaveCount(0);
  await expect.poll(() => editor.locator("p").textContent()).toBe("- ");
});

/**
 * The same mechanism, on a mark input rule rather than a list one — and
 * the visible behaviour change the ticket explicitly calls out: Backspace
 * right after `**bold**` now un-bolds the word and restores the literal
 * asterisks, rather than deleting just the last letter the way it did
 * before this ticket. Intended (it's UpNote's own behaviour, and
 * `undoInputRule` degrades to ordinary character deletion the rest of the
 * time — this is only reachable in the single keystroke right after an
 * input rule fires), but flagged here because it changes a very common
 * keystroke's behaviour in a visible way.
 */
test('Backspace right after "**bold**" undoes the bold input rule, restoring the asterisks', async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("**bold**");
  await expect(editor.locator("strong")).toHaveText("bold");

  await editor.press("Backspace");

  await expect(editor.locator("strong")).toHaveCount(0);
  await expect.poll(() => editor.locator("p").textContent()).toBe("**bold**");
});

/**
 * SUPERSEDED by issue #233 / ADR 0070 — restated here, not deleted, per
 * that ticket's own instruction. The read this test used to assert — Tab
 * outside a list falls through to the browser's own native focus move
 * because `sinkListItem` returns `false` there — was correct for what
 * `indent.run` alone could do, but it copied UpNote's OWN behaviour
 * (insert a literal U+2003 EM SPACE, keep focus) in the wrong direction:
 * this Composer, unlike UpNote's own note editor, sits ahead of a Format
 * toolbar and a Send button in tab order, so letting a forward Tab escape
 * it is itself the keyboard trap (WCAG 2.1.2) — a reader who tabs IN can
 * never tab back OUT the same way without an equally out-of-the-ordinary
 * Shift+Tab first. ADR 0070's decision: Tab is swallowed unconditionally,
 * everywhere, matching UpNote's own literal keystroke; Shift-Tab in bare
 * prose with nothing to undo is the documented keyboard exit instead. The
 * three tests below assert that new contract; none of them quietly drops
 * "does Tab ever trap focus" as a question this suite still asks.
 */
test("Tab outside a list inserts a literal U+2003 em space and keeps focus — never a native focus move", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("ab");
  await expect(editor).toBeFocused();

  await editor.press("Tab");
  await editor.pressSequentially("cd");

  await expect(editor).toBeFocused();
  await expect.poll(() => editor.locator("p").textContent()).toBe("ab cd");
});

test("Shift-Tab in bare prose deletes one preceding em space and keeps focus", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("ab");
  await editor.press("Tab");
  await expect.poll(() => editor.locator("p").textContent()).toBe("ab ");

  await editor.press("Shift+Tab");

  await expect(editor).toBeFocused();
  await expect.poll(() => editor.locator("p").textContent()).toBe("ab");
});

test("Shift-Tab in bare prose with no em space to undo is the documented keyboard exit — focus moves backward, content untouched", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("plain prose, no list here");
  await expect(editor).toBeFocused();

  await editor.press("Shift+Tab");

  await expect(editor).not.toBeFocused();
  await expect.poll(() => editor.locator("p").textContent()).toBe("plain prose, no list here");
});

/**
 * The reported defect itself (issue #233): Tab on the FIRST item of a list
 * used to fall through to native focus navigation the same way plain
 * prose did, because `sinkListItem` refuses an item with no preceding
 * sibling — the case people hit first, since it is the very first Tab
 * press in a brand-new list. `sinkFirstListItem` (composer-commands.ts,
 * ADR 0071) wraps that lone item under a freshly created, empty PARENT
 * list item instead — this schema's own stand-in for UpNote's sibling-
 * `<ul>` nesting, which needs no such wrapper. That parent renders
 * markerless (`index.css`'s own `.ProseMirror li` rules) since it holds no
 * text of its own.
 */
test("Tab nests the first item of a list too, under a markerless empty parent", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- alpha");
  await editor.press("Enter");
  await editor.pressSequentially("bravo");
  // Back onto "alpha" — the list's first item, with no PRECEDING sibling
  // for plain sinkListItem to sink it under. ArrowUp moves the caret across
  // a block boundary (from "bravo"'s own item back to "alpha"'s), and
  // `caretToStartOfLine`'s own comment (above) names the general hazard: a
  // keypress fired before ProseMirror's DOMObserver has flushed the
  // previous one's mutation is simply lost — pressing Tab immediately after
  // ArrowUp risks it landing while the caret is still on "bravo", which
  // would sink "bravo" under "alpha" (plain `sinkListItem`, a preceding
  // sibling IS available there) instead of exercising `sinkFirstListItem`
  // at all. Poll and retry the ArrowUp itself, the same "confirm the move
  // landed" idiom the mid-text Enter test above (composer.spec.ts) already
  // uses for an ArrowLeft race of the identical shape.
  await expect
    .poll(
      async () => {
        const landed = await page.evaluate(
          () => window.getSelection()?.anchorNode?.textContent ?? "",
        );
        if (landed !== "alpha") {
          await editor.press("ArrowUp");
        }
        return landed;
      },
      { message: "caret never reached the list's first item" },
    )
    .toBe("alpha");
  await editor.press("Tab");

  // "alpha" nests one level under a new parent; "bravo" stays a top-level
  // sibling of that parent, untouched.
  await expect(editor.locator("ul ul > li", { hasText: "alpha" })).toHaveCount(1);
  await expect(editor.locator("ul > li", { hasText: "bravo" })).toHaveCount(1);

  // The new parent item itself — the FIRST top-level <li> — carries no
  // marker, since it holds nothing but the nested list.
  await expect(editor.locator("ul > li").first()).toHaveCSS("list-style-type", "none");
});

test("a nested list survives Send and reloads at the same depth", async ({ page }) => {
  const top = uniqueEntryBody("composer-nest-top");
  const mid = uniqueEntryBody("composer-nest-mid");
  const deep = uniqueEntryBody("composer-nest-deep");

  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(`- ${top}`);
  await editor.press("Enter");
  await editor.pressSequentially(mid);
  await editor.press("Tab");
  await editor.press("Enter");
  await editor.pressSequentially(deep);
  await editor.press("Tab");
  await page.getByRole("button", { name: "Send" }).click();

  const bubble = page.locator('[data-slot="bubble-body"]', { hasText: top });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator("ul > li", { hasText: top })).toHaveCount(1);
  await expect(bubble.locator("ul ul > li", { hasText: mid })).toHaveCount(1);
  await expect(bubble.locator("ul ul ul > li", { hasText: deep })).toHaveCount(1);

  await page.reload();

  // The exact same three-level shape, read back from a fresh parse of the
  // Sent body — not merely "still visible," which a flattened list would
  // also satisfy.
  const bubbleAfterReload = page.locator('[data-slot="bubble-body"]', { hasText: top });
  await expect(bubbleAfterReload).toBeVisible();
  await expect(bubbleAfterReload.locator("ul > li", { hasText: top })).toHaveCount(1);
  await expect(bubbleAfterReload.locator("ul ul > li", { hasText: mid })).toHaveCount(1);
  await expect(bubbleAfterReload.locator("ul ul ul > li", { hasText: deep })).toHaveCount(1);
});

/**
 * "A checklist can nest under an ordered item and vice versa — the model
 * already allows mixed types" (the ticket's own acceptance criterion,
 * true at the schema level: `list_item.checked`, entry-schema.ts, carries
 * no restriction tied to which list type encloses it). What this test
 * pins down is narrower and honest about what typing alone can actually
 * reach: `sinkListItem` (prosemirror-schema-list) always nests a new list
 * of the SAME type as the item's own current list — verified by reading
 * its source, not assumed — so Tab alone can never turn an item typed
 * under `1. ` into a `<ul>`. `checkboxInputRule`'s own guard
 * (composer-editor.ts), by contrast, checks only "is the caret inside SOME
 * list_item," never which type of list that item belongs to — so an item
 * nested under an ordered item, itself still technically an `<ol>`, can
 * freely become a task the same way a bullet item can, and
 * `listItemNodeView`'s task rendering (checkbox, `list-none`) does not
 * vary with the parent list's type either. That is the reachable, typed
 * proof this ticket's "mixed types" criterion actually has, short of
 * seeding a document some other way than the Composer's own input rules.
 */
test("a checklist item nests under an ordered item", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("1. plan");
  await editor.press("Enter");
  // Sinks the fresh, still-empty second ordered item under "plan" before
  // it has any content of its own to convert.
  await editor.press("Tab");
  await editor.pressSequentially("[ ] pack bags");

  const checkbox = editor.locator('input[type="checkbox"]');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(editor).not.toContainText("[");

  await expect(editor.locator("ol > li", { hasText: "plan" })).toHaveCount(1);
  // The checkbox lives inside a SECOND, nested list, not beside "plan" in
  // its own outer one.
  await expect(editor.locator("ol ol").locator('input[type="checkbox"]')).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Issue #235: converting existing content into a list, nesting it, and
// converting it back — without losing any of it. Everything above tests
// typing INTO a structure; this section tests converting content INTO and
// OUT OF one, plus Tab/checklist safety on a real multi-item selection.
//
// A genuine multi-block PLAIN-prose selection (two separate top-level
// paragraphs, neither one a list) has no live keystroke path to build at
// all right now: Enter is a soft break everywhere in this Composer today
// (issue #234 — making Enter split a block outside a list — has not
// shipped; ADR 0069's own Status section says so plainly). Every fixture
// below therefore builds its multi-block selection out of LIST items
// instead (`- ` markers plus Enter, which DOES split within a list,
// unchanged since issue #210) — the one shape this Composer can reach by
// keyboard today that still exercises every multi-block code path this
// ticket adds. composer-commands.test.ts's own new "issue #235" describe
// blocks cover the literal N-plain-blocks case directly, by constructing
// the ProseMirror document rather than typing it — see that file's own
// comment on `paragraph` for the identical reasoning.
// ---------------------------------------------------------------------------

test("un-listing a flat 3-item list restores three separate plain blocks with text unchanged — the non-lossy, Android-matching divergence from macOS's own <br>-joined collapse (ADR 0072)", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.click();
  await editor.pressSequentially("- alpha");
  await editor.press("Enter");
  await editor.pressSequentially("bravo");
  await editor.press("Enter");
  await editor.pressSequentially("charlie");
  await expect(editor.locator("li")).toHaveCount(3);

  await editor.press("ControlOrMeta+a");
  const bulletButton = toolbar.getByRole("button", { name: "Bullet list" });
  await bulletButton.click();

  // Three separate blocks, not UpNote's own macOS collapse to one — and
  // every word survives.
  await expect(editor.locator("li")).toHaveCount(0);
  await expect(editor.locator("ul")).toHaveCount(0);
  await expect(editor).toContainText("alpha");
  await expect(editor).toContainText("bravo");
  await expect(editor).toContainText("charlie");
});

test("un-listing a 3-level nested selection flattens one level per press, not UpNote's own strip/re-normalise alternation (ADR 0072, Gap sweep #2 Group I1)", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.click();
  await editor.pressSequentially("- top");
  await editor.press("Enter");
  await editor.pressSequentially("mid");
  await editor.press("Tab");
  await editor.press("Enter");
  await editor.pressSequentially("deep");
  await editor.press("Tab");
  await expect(editor.locator("ul ul ul > li", { hasText: "deep" })).toHaveCount(1);

  await editor.press("ControlOrMeta+a");
  const bulletButton = toolbar.getByRole("button", { name: "Bullet list" });

  // Press 1: "top" (the only level-1 item) outdents fully to plain; "mid"
  // and "deep" each shift up one level, keeping their own relative nesting.
  // `liftEveryTouchedTopLevelList` (composer-commands.ts) only lifts
  // TOP-LEVEL lists the selection touches — there is exactly one here (the
  // outer bullet_list holding "top"), so exactly one `liftListItem` call
  // happens, on "top"'s own single-item list. Lifting a list_item splices
  // its own children (its leading paragraph AND its nested list) directly
  // into the parent, so "top" becomes a plain paragraph sibling of its own
  // former nested list — leaving TWO separate `<ul>`s behind, not one:
  // "mid"'s own list, still containing "deep"'s own still-nested list
  // inside it.
  await bulletButton.click();
  await expect(editor.locator("li")).toHaveCount(2);
  await expect(editor.locator("ul")).toHaveCount(2);
  await expect(editor).toContainText("top");

  // Press 2 (re-select first — the toolbar's own pressed state re-derives
  // from the caret, and this test wants the SAME multi-block selection
  // each press, matching the fixture's own "Cmd+A, then the chord" shape).
  await editor.press("ControlOrMeta+a");
  await bulletButton.click();
  await expect(editor.locator("li")).toHaveCount(1);

  // Press 3: fully flat — three presses for three levels, not UpNote's own
  // five-press alternation.
  await editor.press("ControlOrMeta+a");
  await bulletButton.click();
  await expect(editor.locator("li")).toHaveCount(0);
  await expect(editor.locator("ul")).toHaveCount(0);
  await expect(editor).toContainText("top");
  await expect(editor).toContainText("mid");
  await expect(editor).toContainText("deep");
});

test("a block containing a soft break survives conversion to a bullet and back, unlike Android's own permanent split (ADR 0072, Gap sweep #2 Group H2)", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.click();
  await editor.pressSequentially("line one");
  await editor.press("Shift+Enter");
  await editor.pressSequentially("line two");
  await expect(editor.locator("p")).toHaveText("line one\nline two");

  await editor.press("ControlOrMeta+a");
  const bulletButton = toolbar.getByRole("button", { name: "Bullet list" });
  await bulletButton.click();

  // ONE item, not two — the soft break survives as a line break inside a
  // single <li>, the way Android's own bullet conversion does NOT.
  await expect(editor.locator("li")).toHaveCount(1);
  await expect(editor.locator("li")).toHaveText("line one\nline two");

  await editor.press("ControlOrMeta+a");
  await bulletButton.click();
  await expect(editor.locator("ul")).toHaveCount(0);
  await expect(editor.locator("p")).toHaveText("line one\nline two");
});

test("Tab never destroys a multi-item selection's text — the multi-block generalisation of Tab's own em-space behaviour (issue #235, ADR 0072 — UpNote's own Tab destroys text here, Gap sweep #2 Group K1)", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- top");
  await editor.press("Enter");
  await editor.pressSequentially("mid");
  await expect(editor.locator("li")).toHaveCount(2);

  await editor.press("ControlOrMeta+a");
  await editor.press("Tab");

  // Neither item's own text was deleted — this exact gesture (Tab across a
  // multi-item selection built from the very first item, with no
  // preceding sibling for the whole range to sink under) destroyed both
  // blocks' text in UpNote, on both platforms, before this ticket.
  await expect(editor).toContainText("top");
  await expect(editor).toContainText("mid");
  await expect(editor.locator("li")).toHaveCount(2);
});

test("Tab across a selected run of plain text indents rather than replacing the selection (issue #235, ADR 0072)", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("alpha bravo");
  await editor.press("ControlOrMeta+a");

  await editor.press("Tab");

  // The selected text is still there, just indented — not replaced by a
  // single em space the way this repo's own pre-#235 Tab (and UpNote's
  // own multi-block Tab) both did.
  await expect(editor).toContainText("alpha bravo");
  await expect.poll(() => editor.locator("p").textContent()).toBe(" alpha bravo");
});

test("Mod-Shift-9 creates a checklist from N list items and toggles every item's checked state, never un-listing — UpNote's own checklist behaviour, matched exactly (Gap sweep #2 Group G2/G3/I3)", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("- milk");
  await editor.press("Enter");
  await editor.pressSequentially("eggs");
  await expect(editor.locator("li")).toHaveCount(2);
  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(0);

  await editor.press("ControlOrMeta+a");
  // UpNote's own verified chord (meologue-parity-docs/upnote-macos-detail.md,
  // "Cmd+Shift+9") — no top-level menu accelerator string, verified alive
  // by direct keypress regardless. `Mod-7`/`Mod-8` (bullet/numbered) are
  // NOT claimed here or anywhere in this Composer — this file's own
  // never-claim list (composer-editor.ts's formatKeymap comment) reserves
  // the whole `Mod-1`..`Mod-9` row for browser tab-switching.
  await editor.press("ControlOrMeta+Shift+9");

  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(editor.locator("li")).toHaveCount(2);

  // A second press never un-lists — it flips every item's checked state
  // instead, matching UpNote's own checklist toggle exactly.
  await editor.press("ControlOrMeta+a");
  await editor.press("ControlOrMeta+Shift+9");
  await expect(editor.locator("li")).toHaveCount(2);
  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(editor.locator('input[type="checkbox"]').nth(0)).toBeChecked();
  await expect(editor.locator('input[type="checkbox"]').nth(1)).toBeChecked();

  // A third press flips back to unchecked.
  await editor.press("ControlOrMeta+a");
  await editor.press("ControlOrMeta+Shift+9");
  await expect(editor.locator('input[type="checkbox"]').nth(0)).not.toBeChecked();
  await expect(editor.locator('input[type="checkbox"]').nth(1)).not.toBeChecked();
});

test("the Mod-Shift-9 checklist flip-all never reaches a Sent Entry's real Tasks — it applies only to the Composer's own in-progress document (issue #235, ADR 0053)", async ({
  page,
}) => {
  const taskOne = uniqueEntryBody("composer-checklist-flip-all-safety-one");
  const taskTwo = uniqueEntryBody("composer-checklist-flip-all-safety-two");
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(`- [ ] ${taskOne}`);
  await editor.press("Enter");
  await editor.pressSequentially(taskTwo);
  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(2);
  await page.getByRole("button", { name: "Send" }).click();

  // Promotion (ADR 0048) has now minted a real Task for each line and
  // rewritten the Entry's own body to reference it — both rows read the
  // same words either way, so `entryRow` (not a bare `getByText`) is what
  // this suite's own existing task-reference tests already establish as
  // load-bearing here (see "editing a Sent checkbox line opens it in the
  // Composer" above).
  await expect(entryRow(page, taskOne)).toBeVisible();
  await expect(entryRow(page, taskTwo)).toBeVisible();

  const row = entryRow(page, taskOne);
  await row.hover();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByText("Editing Entry")).toBeVisible();

  const reopened = composerField(page);
  const checkboxes = reopened.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(2);
  // Every promoted checkbox renders disabled (taskReferenceNodeView,
  // issue #177/#181) — reading, not a control, even before this chord is
  // ever pressed.
  await expect(checkboxes.nth(0)).toBeDisabled();
  await expect(checkboxes.nth(1)).toBeDisabled();
  await expect(checkboxes.nth(0)).not.toBeChecked();
  await expect(checkboxes.nth(1)).not.toBeChecked();

  await reopened.click();
  await reopened.press("ControlOrMeta+a");
  await reopened.press("ControlOrMeta+Shift+9");

  // Nothing changed — both cached checkboxes are still exactly what they
  // were, and the real Tasks behind them were never touched. A flip-all
  // that reached this document would have mass-completed them and synced
  // that everywhere (ADR 0053).
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.nth(0)).not.toBeChecked();
  await expect(checkboxes.nth(1)).not.toBeChecked();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Editing Entry")).toHaveCount(0);
});

/**
 * The underscore spellings, which the READER has always understood.
 *
 * `parseEntryMarkdown` is CommonMark, so `_x_` and `__x__` render as
 * emphasis and strong whether the Composer knows them or not. Before the
 * matching input rules existed, a body typed as `remember _this_` showed
 * literal underscores the whole time it was being written and then turned
 * italic the moment it was Sent — precisely the "the editor lies about what
 * you will get" complaint issue #155 exists to remove, surviving inside the
 * fix for it. The intraword case is the one that keeps a guard honest:
 * CommonMark refuses `_` emphasis inside a word, so a variable name must
 * come through untouched.
 */
test("underscores mark emphasis, except inside a word", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("remember _this_ and __that__ but not snake_case_var");

  await expect(editor.locator("em")).toHaveText("this");
  await expect(editor.locator("strong")).toHaveText("that");
  // The variable name keeps its underscores and gains no formatting.
  await expect(editor).toContainText("snake_case_var");
  await expect(editor.locator("em")).toHaveCount(1);
  await expect(editor.locator("strong")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Issue #212: Enter is a soft break outside a list — this is the reported
// defect's own fix. Pressing Enter once used to render as a blank line
// (ADR 0066 has the full mechanism: a paragraph split's own required `\n\n`
// separator IS a blank line, under the `white-space: pre-wrap` every prose
// surface sets). One Enter must now give one new line; two Enters must give
// exactly one blank line, no more.
// ---------------------------------------------------------------------------

test("alpha, Enter, bravo — two sibling blocks, Send and reopening for edit round-tripping it byte-identically (ADR 0069)", async ({
  page,
}) => {
  const marker = uniqueEntryBody("composer-enter-splits-block");
  // `entryDocumentToMarkdown`'s writer separates paragraph siblings with an
  // unconditional `\n\n` (ADR 0069's Decision) — this IS the byte-identical
  // stored form of "two blocks, no gap on screen", not a blank line: the
  // reader's own "any non-empty run of bare `\n` is exactly one block
  // boundary" rule (`collectBlocks`) is what turns it back into two
  // paragraphs with no rendered gap between them.
  const body = `${marker}\n\nbravo`;
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(marker);
  await editor.press("Enter");
  await editor.pressSequentially("bravo");

  // Two `<p>`s, not one — Enter splits the block now (ADR 0069 supersedes
  // ADR 0066's soft-break Enter); a soft break that stays in ONE paragraph
  // is what Shift+Enter does instead ("Shift+Enter behaves exactly like
  // Enter", below).
  await expect(editor.locator("p")).toHaveCount(2);
  await expect.poll(() => editor.locator("p").nth(0).textContent()).toBe(marker);
  await expect.poll(() => editor.locator("p").nth(1).textContent()).toBe("bravo");

  await page.getByRole("button", { name: "Send" }).click();
  // An EXACT match against the two-blank-newline-separated string
  // (`waitForEntryId`'s own query is `body = <literal>`) is itself the
  // byte-identical proof at the Server: if the Composer had serialized
  // this as one soft-broken paragraph instead of two block siblings, the
  // stored body would carry a single `\n`, not `\n\n`, and this lookup
  // would never resolve.
  const id = await waitForEntryId(body, SERVER_A_DATABASE);
  expect(id).toBeDefined();

  const bubble = page.locator('[data-slot="bubble-body"]', { hasText: marker });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator("p")).toHaveCount(2);

  // Reopen for edit — the Composer re-parses the stored body
  // (`entryMarkdownToDocument`) back into a live document; the round trip
  // is byte-identical only if that re-parse produces the SAME two
  // paragraphs, not one paragraph carrying an internal `\n`.
  const row = entryRow(page, marker);
  await row.hover();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByText("Editing Entry")).toBeVisible();
  const reopenedEditor = composerField(page);
  await expect(reopenedEditor.locator("p")).toHaveCount(2);
  await expect.poll(() => reopenedEditor.locator("p").nth(0).textContent()).toBe(marker);
  await expect.poll(() => reopenedEditor.locator("p").nth(1).textContent()).toBe("bravo");
});

test("alpha, Enter, Enter, bravo — three sibling blocks, one blank between them; the blank one does not survive Send (ADR 0069, issue #239)", async ({
  page,
}) => {
  const marker = uniqueEntryBody("composer-two-enters-blank-line");
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(marker);
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially("bravo");

  // Three `<p>`s — marker, an EMPTY one, and bravo — not one paragraph
  // carrying two internal soft breaks. "Exactly one blank line" is now a
  // block-spacing property (`BLOCK_SPACING`'s `mt-0`, entry-prose.tsx: a
  // block boundary costs exactly one line-height, ADR 0069's Decision),
  // not a run of `\n` characters inside a single paragraph the way ADR
  // 0066 modeled it.
  await expect(editor.locator("p")).toHaveCount(3);
  await expect.poll(() => editor.locator("p").nth(0).textContent()).toBe(marker);
  await expect.poll(() => editor.locator("p").nth(1).textContent()).toBe("");
  await expect.poll(() => editor.locator("p").nth(2).textContent()).toBe("bravo");

  // Issue #239, a known, deliberate gap named in ADR 0069's own
  // Consequences: a genuinely empty paragraph has no Markdown spelling of
  // its own. The writer's unconditional `\n\n` separator between
  // p(marker), p(""), and p("bravo") round-trips as
  // "marker\n\n\n\nbravo", and the reader's own "any non-empty run of bare
  // `\n` is exactly one block boundary" rule (`collectBlocks`) reads that
  // straight back as TWO paragraphs, not three — the blank middle one does
  // not survive a Send. This is not something to fix here; it is the
  // accepted, open gap #239 records.
  await page.getByRole("button", { name: "Send" }).click();
  const bubble = page.locator('[data-slot="bubble-body"]', { hasText: marker });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator("p")).toHaveCount(2);
  await expect.poll(() => bubble.locator("p").nth(0).textContent()).toBe(marker);
  await expect.poll(() => bubble.locator("p").nth(1).textContent()).toBe("bravo");
});

test("alpha, Enter, - milk, Enter, eggs — a paragraph plus a two-item bullet list", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("alpha");
  await editor.press("Enter");
  // The bullet marker is typed right after a soft break, not at a fresh
  // block's own start — exactly the case issue #212's `(?:^|\n)` widening
  // (`lineStartWrappingInputRule`, composer-editor.ts) exists for. Without
  // it, "- milk" would stay literal text on screen while the stored body
  // parsed as a real list the instant it was Sent.
  await editor.pressSequentially("- milk");
  // Caret is now inside the freshly-converted list item — Enter here is
  // still `splitListItemUnchecked` (unchanged by issue #212), not a soft
  // break, so this opens a SECOND list item rather than inserting a `\n`.
  await editor.press("Enter");
  await editor.pressSequentially("eggs");

  await expect(editor.locator("p").first()).toHaveText("alpha");
  await expect(editor.locator("ul > li")).toHaveCount(2);
  await expect(editor.locator("ul > li").nth(0)).toHaveText("milk");
  await expect(editor.locator("ul > li").nth(1)).toHaveText("eggs");
});

/**
 * Issue #212 changes what this test's own middle section proves. Before
 * that ticket, Shift+Enter fell through to `splitBlock` — a second `<p>`,
 * matching plain Enter's own pre-#212 paragraph split — and this test's
 * only job was "still doesn't send." Now that plain Enter is itself a soft
 * break (`insertSoftBreak`, composer-commands.ts), Shift+Enter is bound to
 * the IDENTICAL chain, not a variant of it (composer-editor.ts's own
 * `listKeymap` comment has the full "why identical, not merely harmless"
 * account) — so this is also the test that proves Shift+Enter behaves like
 * Enter now, not only that it still refuses to send.
 */
test("Shift+Enter behaves exactly like Enter — a soft break in one paragraph, never sends", async ({
  page,
}) => {
  const firstLine = uniqueEntryBody("composer-shift-enter-one");
  const secondLine = uniqueEntryBody("composer-shift-enter-two");
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(firstLine);
  await editor.press("Shift+Enter");
  await editor.pressSequentially(secondLine);

  // One `<p>`, not two — a soft break, exactly like plain Enter, not a
  // block split.
  await expect(editor.locator("p")).toHaveCount(1);
  await expect.poll(() => editor.locator("p").textContent()).toBe(`${firstLine}\n${secondLine}`);

  // Still in the field — nothing was sent. This suite runs its specs
  // sequentially against one shared server (playwright.config.ts's own
  // `fullyParallel: false`), so History already carries whatever every
  // earlier spec in this run sent — the two lines' own unique bodies are
  // what a "nothing sent" check has to name, not History's total count.
  // Scoped to a History bubble specifically (not a bare `getByText`, which
  // would also match the two lines still sitting, unsent, in the field
  // itself).
  await expect(page.locator('[data-slot="bubble-body"]', { hasText: firstLine })).toHaveCount(0);
  await expect(page.locator('[data-slot="bubble-body"]', { hasText: secondLine })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Issue #214 / ADR 0067: the one-time pass that used to halve a run of
// newlines written before Enter meant one line per press. ADR 0069's own
// Consequences section names this pass HISTORICAL rather than superseded —
// it still runs, unchanged, and is still safe to leave running, but nothing
// built through the real parser can hand it a shape left to halve any more:
// `collectBlocks` now splits at every bare `\n` boundary before the pass
// ever sees a stored body, so a top-level paragraph leaf can no longer
// carry an "old Enter" run at all. `soft-break-migration.test.ts`'s own
// "equals the plain round trip for every case in this file" test is the
// pure-function proof of that; this spec is the same finding proven against
// a real, opened store rather than reasoned about in isolation — it seeds a
// pre-cutoff Entry (backdated `updated_at`, `installDateOffset`/
// `advanceDateByDays`, helpers.ts), Sends it, then drives a real self-Merge
// (merge.spec.ts's own file-chooser technique) to re-arm the migration's
// marker and prove it runs and changes nothing.
//
// Enter can no longer seed a raw, un-escaped `\n` run through the Composer
// at all (ADR 0069: Enter splits a block; `escapeUserText` now escapes
// every embedded `\n` a soft break leaves behind), so the closest
// reproduction of "several old Enters in a row" is several REAL Enters —
// each splitting its own block — which issue #239 (below) already shows
// collapses to two blocks the moment it is Sent, with or without any
// migration involved.
//
// A Merge, not a plain reload, is what actually lets this test SEE the
// migration run against this particular Entry: the migration's own
// "already ran" marker (`kv`) is set the very first time this fresh Device
// opens its (empty) store at all, at the very first `page.goto` below —
// before the Entry this test cares about even exists — so an ordinary
// reload alone would find the marker already set and skip the scan
// entirely. Merge re-arms that marker (ADR 0067's own acceptance
// criterion: "A Merge re-arms the pass") — chosen over Restore for that
// same re-arming, and a self-Merge changes nothing else (every row is
// byte-identical to what is already here, so `mergeTable`'s own
// content-diff skips all of them).
//
// Merge was ALSO originally chosen to dodge a hazard that no longer
// exists, and the reason is worth keeping rather than deleting: Restore
// resets this Device's Sync Cursor to 0 (`restoreTable`'s own
// `resetCursorsAndEpochs`, which Merge has no equivalent of), so the very
// next pull brings this Device's *entire* History back, and
// `EntryStore.upsert`'s unconditional overwrite could land after this
// migration's own `store.edit()` and silently stomp the freshly-processed
// body back to its pre-migration shape. That was issue #215, fixed by
// ADR 0068: the pull now goes through `EntryStore.applyPulled`, which
// refuses a stale row sitting on top of an unpushed local edit. Merge is
// kept here anyway — it is the cheaper of the two re-arming paths and
// this spec is already the heaviest chain in this file — while the
// Restore path's own version of this is covered deterministically in
// `packages/core/src/backup/restore.test.ts`, where it does not depend on
// winning a load-sensitive race to mean anything.
// ---------------------------------------------------------------------------

test("a pre-cutoff Entry's several Enters collapse to two blocks on Send (issue #239), and a re-armed halving pass changes nothing — it is historical now (ADR 0069)", async ({
  page,
}) => {
  // Longer than this file's implicit default (`playwright.config.ts`'s
  // `timeout: 60_000`): this test drives a real Backup, a real self-Merge
  // (its own reload plus a safety-Backup download), the Tasks backfill and
  // this migration, and an Edit round trip — the heaviest single chain
  // this file runs.
  test.setTimeout(120_000);

  const marker = uniqueEntryBody("composer-soft-break-migration");

  // `installDateOffset` only reaches documents navigated to AFTER it's
  // registered (its own doc comment) — must run before the very first
  // `page.goto` below.
  await installDateOffset(page);
  await page.goto("/composer");

  // Backdated well before `BODY_SOFT_BREAK_CUTOFF` (packages/core/src/protocol.ts)
  // — 400 days covers any real clock this suite could possibly run against
  // relative to that fixed instant. `EntryStore.edit`/the initial capture
  // both stamp `updated_at`/`created_at` from this same, now-offset clock.
  await advanceDateByDays(page, -400);

  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(marker);
  // Four Enters, back to back — under ADR 0069 each one SPLITS a new
  // block, so this seeds five sibling paragraphs (marker, three blank
  // ones, and — once typed — tail): the closest thing to "several old
  // Enters in a row" reachable through the Composer's own keymap now that
  // Enter no longer inserts a literal `\n`. `pressEnterUntilBlockCount`
  // (above) polls the paragraph count rather than assuming four presses
  // land as four splits, the same "confirm it landed, don't assume it"
  // reasoning `caretToStartOfLine`'s own comment already names.
  await pressEnterUntilBlockCount(editor, 5);
  await editor.pressSequentially("tail");
  await expect(editor.locator("p")).toHaveCount(5);

  await page.getByRole("button", { name: "Send" }).click();
  const bubble = page.locator('[data-slot="bubble-body"]', { hasText: marker });
  await expect(bubble).toBeVisible();

  // Issue #239: none of the three blank paragraphs between marker and tail
  // survives the round trip. `entryDocumentToMarkdown`'s writer separates
  // every paragraph sibling with an unconditional `\n\n` — five siblings,
  // three of them empty, write out as one long run of bare `\n`
  // (`marker` + `\n\n\n\n\n\n\n\n` + `tail`) — and the reader's own "any
  // non-empty run of bare `\n` is exactly one block boundary" rule
  // (`collectBlocks`, ADR 0069) reads that straight back as ONE boundary
  // regardless of how many Enters produced it. Two blocks survive, not
  // five and not three.
  await expect(bubble.locator("p")).toHaveCount(2);
  await expect.poll(() => bubble.locator("p").nth(0).textContent()).toBe(marker);
  await expect.poll(() => bubble.locator("p").nth(1).textContent()).toBe("tail");

  // Back to the real clock — everything from here on (Settings' own
  // filenames, the reads below) should behave normally; only the Entry's
  // already-stamped `updated_at` needs to stay backdated, and it does,
  // untouched by this. Also gives Sync a real, unhurried moment to push
  // this Entry (this suite's default Server URL keeps Sync live) and
  // settle before the self-Merge below, rather than racing it.
  await advanceDateByDays(page, 0);
  // The exact stored bytes — the writer's unconditional `\n\n` between five
  // siblings, three of them empty, concatenates into one eight-`\n` run.
  await waitForEntryId(`${marker}\n\n\n\n\n\n\n\ntail`, SERVER_A_DATABASE);

  // Back up this (still, per `updated_at`, pre-cutoff) Device, then
  // immediately Merge that same Backup into itself — merge.spec.ts's own
  // file-chooser dance, reused verbatim, aimed at this same page rather
  // than a second Device. The point is not "this Device gains rows it was
  // missing" (a self-Merge is a no-op on content — merge.ts's own
  // `rowContentUnchanged` skips every row here, since the Backup and this
  // Device agree byte for byte); it is that Merge's own
  // `rearmSoftBreakMigration` step (merge.ts) clears the migration's
  // marker unconditionally, so the reload it performs on success is a
  // genuinely fresh, re-armed store-open — the first one to ever see this
  // particular Entry.
  await openDestination(page, "Settings");
  const backupButton = page.getByRole("button", { name: "Back up this Device" });
  await expect(backupButton).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), backupButton.click()]);
  const backupPath = await download.path();
  expect(backupPath).not.toBeNull();

  const mergeButton = page.getByRole("button", { name: "Merge a Backup…" });
  await expect(mergeButton).toBeEnabled();
  // Merge's own confirm() is a native dialog — Playwright dismisses one by
  // default, so accepting it needs an explicit listener registered before
  // the click that raises it (merge.spec.ts's own identical comment).
  page.once("dialog", (dialog) => dialog.accept());
  const [fileChooser] = await Promise.all([page.waitForEvent("filechooser"), mergeButton.click()]);
  // Registered before `setFiles`, for the identical reason merge.spec.ts's
  // own comment gives: an event already fired cannot be waited for after.
  const safetyBackup = page.waitForEvent("download");
  const reloaded = page.waitForEvent("load");
  await fileChooser.setFiles(backupPath as string);
  expect((await safetyBackup).suggestedFilename()).toContain("meologue-safety-backup-");
  await reloaded;

  await openDestination(page, "Composer");
  const bubbleAfterMerge = page.locator('[data-slot="bubble-body"]', { hasText: marker });
  await expect(bubbleAfterMerge).toBeVisible();
  // ADR 0069's own Consequences: the halving pass is now historical — it
  // still runs (this Entry's backdated `updated_at` still makes it
  // eligible for the scan), but nothing built through the real parser can
  // hand it a shape left to halve any more. Re-arming it via Merge changes
  // nothing: still exactly two blocks, byte-identical to what Send already
  // produced above — the live-store proof of `soft-break-migration.test.ts`'s
  // own "equals the plain round trip" finding.
  await expect
    .poll(() => bubbleAfterMerge.locator("p").count(), {
      message: "the re-armed pass is historical now — it must not remove or add a block",
    })
    .toBe(2);
  await expect.poll(() => bubbleAfterMerge.locator("p").nth(0).textContent()).toBe(marker);
  await expect.poll(() => bubbleAfterMerge.locator("p").nth(1).textContent()).toBe("tail");

  // The STORED body, not merely the rendered result: reopening for Edit
  // re-parses the Entry's real, persisted text (`entryMarkdownToDocument`)
  // — this is the "alpha, Enter, bravo" test's own byte-identical-round-trip
  // technique, applied to what Merge's re-armed pass left behind rather
  // than to what the Composer wrote.
  const row = entryRow(page, marker);
  await row.hover();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByText("Editing Entry")).toBeVisible();
  const reopenedEditor = composerField(page);
  await expect(reopenedEditor.locator("p")).toHaveCount(2);
  await expect.poll(() => reopenedEditor.locator("p").nth(0).textContent()).toBe(marker);
  await expect.poll(() => reopenedEditor.locator("p").nth(1).textContent()).toBe("tail");
  // Leave edit mode without committing — this Entry's `updated_at` is now
  // whatever the migration's own `store.edit` stamped it to (past the
  // cutoff), and a real Send here would bump it again for an unrelated
  // reason, muddying the second-reload assertion below.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Editing Entry")).toHaveCount(0);

  // A later reload (no further Merge, so the marker Merge set is still in
  // place) must leave the body exactly alone — it was already at its
  // fixpoint the moment Send first wrote it, unrelated to whether the
  // migration's own idempotency ever mattered here.
  await page.reload();

  const bubbleAfterSecondReload = page.locator('[data-slot="bubble-body"]', { hasText: marker });
  await expect(bubbleAfterSecondReload).toBeVisible();
  await expect
    .poll(() => bubbleAfterSecondReload.locator("p").count(), {
      message: "a later store-open must not change an already-fixpoint body",
    })
    .toBe(2);
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
  // `exact: true` — a referenced Task's own words are a real button too
  // (entry-row.tsx's `TaskReferenceItem`, issue #181); a substring match
  // on "Edit" could in principle also hit a fixture body containing those
  // letters.
  await row.getByRole("button", { name: "Edit", exact: true }).click();
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

// Issue #177: a Sent checkbox line is promoted into a Task reference (ADR
// 0048) the moment it Sends, and `task_reference` (entry-schema.ts) had no
// renderer anywhere the Composer's EditorView could reach — opening it for
// editing crashed inside a `useEffect`, and with no error boundary
// anywhere in the app, React 19 unmounted the ENTIRE tree, not just the
// Composer. Issue #174's backfill means nearly every historical checkbox
// carried this same, previously un-editable shape.
test("editing a Sent checkbox line opens it in the Composer instead of blanking the screen", async ({
  page,
}) => {
  const body = uniqueEntryBody("composer-task-reference-edit");
  await page.goto("/composer");
  await sendEntry(page, `- [ ] ${body}`);

  // Promotion writes the Task's own cached label back into the row, which
  // reads identically to what was typed either way — this is the row
  // ADR 0048 says is now a live Task reference, not a plain checkbox line.
  //
  // `entryRow`, never a bare `getByText(body)`: promoting this line minted a
  // Task dated today (issue #173's capture-date rule), so the identical words
  // now ALSO render in today's Day block (issue #174, history.tsx's
  // `DayTasksRow`) — a bare text match resolves to two elements and fails
  // Playwright's strict mode. Every assertion in a task-bearing spec has to
  // say WHICH of the two surfaces it means.
  await expect(entryRow(page, body)).toBeVisible();

  const row = entryRow(page, body);
  await row.hover();
  // `exact: true` — this fixture's own body, "composer-task-reference-edit
  // <uuid>", contains the word "edit," which the Task reference's own
  // clickable words (entry-row.tsx's `TaskReferenceItem`, issue #181)
  // render as a `<button>` inside this same row — a loose substring match
  // resolves both buttons and Playwright's strict mode refuses to guess
  // between them.
  await row.getByRole("button", { name: "Edit", exact: true }).click();

  // The crash this ticket fixes took the WHOLE screen down, not merely the
  // Composer — asserting the app's own persistent chrome ("Editing Entry",
  // the Cancel affordance) survived is as important as asserting the
  // checkbox itself rendered.
  await expect(page.getByText("Editing Entry")).toBeVisible();
  const editor = composerField(page);
  const checkbox = editor.locator('input[type="checkbox"]');
  await expect(checkbox).toHaveCount(1);
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).not.toBeChecked();
  await expect(editor).toContainText(body);

  // Reading further proves the app never unmounted: Cancel still works,
  // leaving edit mode the ordinary way rather than the page having become
  // inert underneath a crashed render.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Editing Entry")).toHaveCount(0);
  await expect(entryRow(page, body)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Issue #181: the Day block gains completion state, ticking and opening —
// history.tsx's own `DayTasksRow`. A Sent checkbox with no date typed
// still mints a Task dated *today* (issue #173's capture-date rule, the
// identical fact the test just above relies on), which is what puts it in
// today's Day block without this suite needing to type a date token.
//
// `[data-testid="day-tasks-row"]` scopes every locator below to the block
// itself, never a bare `getByText`/`getByRole("button", {name: body})` —
// this ticket's own change is exactly what makes that collision worse (the
// row now also carries chips and a done/total count, on top of the
// pre-existing entry-reference-vs-day-block duplication the test above
// already has to work around).
// ---------------------------------------------------------------------------

test("ticks and un-ticks a Task from the Day block, and each survives a reload", async ({
  page,
}) => {
  const body = uniqueEntryBody("composer-day-block-tick");
  await page.goto("/composer");
  await sendEntry(page, `- [ ] ${body}`);

  const dayBlockRow = page.getByTestId("day-tasks-row").locator("li", { hasText: body });
  const checkbox = dayBlockRow.getByRole("checkbox");
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeEnabled();

  // A single `click()` is not enough here, confirmed against a captured
  // trace (issue #181's own coordinator gap-fix report — this test failed
  // deterministically in a full-file run, never in isolation, which is
  // the signature of issue #190's leaked Tasks: by test #29 today's Day
  // block already holds dozens of accumulated rows). The trace's own call
  // log showed the checkbox reading NATIVELY checked on most polls right
  // after the click, then reverting to unchecked by the time the
  // assertion timed out — a controlled `<input>` snapping back to
  // `checked={done}`'s own value, not a click that missed its target
  // outright. `history.tsx`'s Day block is one row inside a virtualized
  // list (`@tanstack/react-virtual`, `OVERSCAN = 25`); a row this far off
  // its `estimateSize` guess (dozens of accumulated `<li>`s, not the
  // single line the virtualizer estimates for an unmeasured row) can
  // still be unmounted and remounted as the viewport's own visible range
  // is recomputed, which is consistent with exactly this: the native
  // browser toggle fires because a real, attached `<input>` received the
  // click, but React's own `onChange` — and therefore `onCompleteTask`,
  // and therefore the actual `completeTask` mutation — never ran on that
  // same node, so the very next re-render reasserts the unchanged
  // `checked={false}` prop and the toggle snaps back. Retrying the CLICK
  // itself, not merely the read, is what recovers from a click that
  // genuinely landed on a node about to be replaced — `toPass` bounds it
  // to the same overall budget every other assertion in this suite gets,
  // it does not raise anything past that.
  await expect(async () => {
    await checkbox.click();
    await expect(checkbox).toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // The checkbox reading checked only proves the LOCAL store agrees (the
  // query cache behind it only updates once `completeTask`'s mutation
  // resolves, which awaits the real local write) — it says nothing about
  // whether that write has reached anywhere a reload's own fresh boot
  // could race against. `requestSync()` fires from inside that same
  // mutation's `onSuccess` but is never awaited (`use-tasks.ts`), so
  // reloading immediately after the UI update races it. Waiting for the
  // Server's own copy to agree first — the same "wait for the actual,
  // externally-checkable condition" discipline `waitForEntryId`/
  // `waitForTombstone` already use for an Entry — is what removes that
  // race, per issue #181's own coordinator gap-fix report (this test was
  // observed flaky without it).
  await waitForTaskCompleted(body, SERVER_A_DATABASE);

  // A reload re-reads the store from scratch — proof this wrote the Task
  // itself (ADR 0048: ticking writes the Task, never a second, day-block-
  // local copy of the bit), not merely optimistic UI that a real store
  // round trip would lose.
  await page.reload();
  const reloaded = page
    .getByTestId("day-tasks-row")
    .locator("li", { hasText: body })
    .getByRole("checkbox");
  await expect(reloaded).toBeChecked();

  // The un-tick half. The Day block's checkbox writes in BOTH directions
  // now (`onUncompleteTask`, history.tsx) — the rule an Entry's own
  // checkbox already followed (`entry-row.tsx`'s `TaskReferenceItem`),
  // which the day block previously refused on the strength of a claim
  // that Todo's own row could reopen a done Task. It cannot: `TaskRow`'s
  // checkbox is hardcoded `checked={false} readOnly`.
  //
  // Extended onto this test rather than given one of its own: every extra
  // Day-block test leaves another row in today's block for every later
  // test to work around (issue #190's own history, and the very reason
  // the retry below exists at all), and the reload above has already left
  // exactly the checked, server-agreed state this half starts from.
  await expect(reloaded).toBeEnabled();
  // Same retry-the-CLICK shape as the tick above, for the same reason —
  // see that comment: a virtualized row can be unmounted and remounted
  // between the click landing and React's own `onChange` running, and a
  // controlled `<input>` then snaps back to its `checked` prop.
  await expect(async () => {
    await reloaded.click();
    await expect(reloaded).not.toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await waitForTaskUncompleted(body, SERVER_A_DATABASE);

  await page.reload();
  await expect(
    page.getByTestId("day-tasks-row").locator("li", { hasText: body }).getByRole("checkbox"),
  ).not.toBeChecked();
});

test("opens a Task from the Day block over the Composer, and Escape returns to it without navigating away", async ({
  page,
}) => {
  const body = uniqueEntryBody("composer-day-block-open");
  await page.goto("/composer");
  await sendEntry(page, `- [ ] ${body}`);

  const dayBlockRow = page.getByTestId("day-tasks-row").locator("li", { hasText: body });
  await dayBlockRow.getByRole("button", { name: body }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const titleField = dialog.getByRole("textbox", { name: "Task title" });
  await expect(titleField).toHaveValue(body);
  // Opening a Task must not take TEXT focus. On a phone, focusing the title
  // opens the soft keyboard the instant a Task is tapped and the bottom
  // sheet jumps as the visual viewport resizes — for a gesture that is
  // usually "look at this Task", not "rename it". Focus parks on the dialog
  // itself instead (`onOpenAutoFocus`, task-detail-view.tsx): still inside
  // the dialog, which is what keeps the Escape below reaching it and keeps
  // focus restorable on close — the reason this is not simply
  // `preventDefault()` with nothing after it.
  await expect(titleField).not.toBeFocused();
  await expect(dialog).toBeFocused();
  // Criterion 4: never left the Composer for `/todo/task/...`.
  expect(page.url()).toContain("/composer");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(composerField(page)).toBeVisible();
  expect(page.url()).toContain("/composer");
});

// ---------------------------------------------------------------------------
// Issue #164: the format toolbar and its keyboard shortcuts.
//
// Every button here reaches through composer-commands.ts's own registry —
// composer-commands.test.ts already proves what each command DOES against a
// plain `EditorState` (ADR 0044: jsdom cannot mount a live `EditorView` at
// all). What can only be proven here, in a real browser, is that the BUTTON
// reaches the right command, that clicking it never costs the caret its own
// selection (composer-toolbar.tsx's own `onMouseDown` comment), and that the
// toolbar's own visibility/pressed/disabled state genuinely tracks focus and
// the caret rather than merely looking right in one static screenshot.
// ---------------------------------------------------------------------------

/**
 * No-op now that the format toolbar is on by default (settings.ts) and
 * Settings (composer-section.tsx) is its only switch — the inline toggle
 * button beside Send this used to click is gone. Kept, rather than deleted
 * along with every call site below, purely so those sites don't all need
 * touching; it just waits for the toolbar row, already visible by default,
 * to render.
 */
async function expectFormatToolbarVisible(page: Page): Promise<void> {
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
}

test("the format toolbar is on by default, stays visible regardless of Composer focus, and the Settings switch persists across a reload", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });

  // On by default (settings.ts) — visible before the Composer has ever
  // been focused, unlike the pre-rework "appears only while the Composer
  // has focus" behaviour.
  await expect(toolbar).toBeVisible();

  // Focusing the field, typing, and moving focus to Send all leave it
  // exactly as visible — `formatBarVisible` alone gates the row now
  // (composer.tsx), with no DOM-focus tracking involved at all. Send needs
  // real content to focus, first: composer.tsx disables it whenever the
  // field is empty (`disabled={disabled || isEmpty}`), and a disabled
  // button is not focusable — `.focus()` on it is a no-op.
  await editor.click();
  await editor.pressSequentially("plain prose, no list here");
  await page.getByRole("button", { name: "Send" }).focus();
  await expect(toolbar).toBeVisible();
  await editor.click();
  await expect(toolbar).toBeVisible();

  // The setting itself is a Device setting (settings.ts), not component
  // state, and Settings is the only place left to flip it — it survives a
  // reload, the same way Accent/text size do (settings.spec.ts's own
  // "persisted the same way theme is" comment).
  await page.goto("/settings");
  const settingsSwitch = page.getByRole("switch", { name: "Show the format toolbar" });
  await expect(settingsSwitch).toHaveAttribute("aria-checked", "true");
  await settingsSwitch.click();
  await expect(settingsSwitch).toHaveAttribute("aria-checked", "false");

  await page.goto("/composer");
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
});

test("the bold, italic, strikethrough and code toolbar buttons apply their marks, reflect the caret's own pressed state, and never blur the editor", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.pressSequentially("word");
  // Selects the whole word — `toggleMark` on an EMPTY selection only
  // primes `storedMarks` for the NEXT typed character (composer-commands.ts's
  // own `markActive` comment); a real, non-empty selection is what makes a
  // click retroactively format text already on screen, the case that
  // actually needs a browser to prove (`inputrules`/marks are otherwise
  // ADR 0044's unit-test territory).
  await editor.press("ControlOrMeta+a");

  const boldButton = toolbar.getByRole("button", { name: "Bold" });
  await expect(boldButton).toHaveAttribute("aria-pressed", "false");
  await boldButton.click();
  await expect(editor.locator("strong")).toHaveText("word");
  await expect(boldButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();

  const italicButton = toolbar.getByRole("button", { name: "Italic" });
  await italicButton.click();
  await expect(editor.locator("em")).toHaveText("word");
  await expect(italicButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();

  const strikethroughButton = toolbar.getByRole("button", { name: "Strikethrough" });
  await expect(strikethroughButton).toHaveAttribute("aria-pressed", "false");
  await strikethroughButton.click();
  await expect(editor.locator("s")).toHaveText("word");
  await expect(strikethroughButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();

  const codeButton = toolbar.getByRole("button", { name: "Code" });
  await codeButton.click();
  await expect(editor.locator("code")).toHaveText("word");
  await expect(codeButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();
});

test("the bulletList toolbar button wraps the caret's paragraph in a bullet list, and toggles back out", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.pressSequentially("buy milk");

  const bulletButton = toolbar.getByRole("button", { name: "Bullet list" });
  await bulletButton.click();
  await expect(editor.locator("ul > li")).toHaveText("buy milk");
  await expect(bulletButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();

  // Pressing it again lifts back out — `toggleListWrap`'s own ordinary
  // toggle meaning (composer-commands.ts), reached identically through the
  // button.
  await bulletButton.click();
  await expect(editor.locator("ul")).toHaveCount(0);
  await expect(bulletButton).toHaveAttribute("aria-pressed", "false");
});

test("the orderedList toolbar button wraps the caret's paragraph in a numbered list", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.pressSequentially("buy milk");

  const orderedButton = toolbar.getByRole("button", { name: "Numbered list" });
  await orderedButton.click();
  await expect(editor.locator("ol > li")).toHaveText("buy milk");
  await expect(orderedButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();
});

test("the checklist toolbar button wraps the caret's paragraph as a task, with an independently tickable checkbox", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.pressSequentially("buy milk");

  const checklistButton = toolbar.getByRole("button", { name: "Checklist" });
  await checklistButton.click();
  const checkbox = editor.locator('input[type="checkbox"]');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(checklistButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();

  await checkbox.click();
  await expect(checkbox).toBeChecked();
});

test("the outdent and indent toolbar buttons lift and sink a list item, and their own enabled state tracks the caret", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.pressSequentially("- first");
  await editor.press("Enter");
  await editor.pressSequentially("second");

  // The caret is in "second," the last item — it has a preceding sibling,
  // so Indent can sink it under "first" (composer-commands.test.ts's own
  // "is enabled on a list item with a preceding sibling" unit case, proven
  // here through the button rather than the bare command).
  const indentButton = toolbar.getByRole("button", { name: "Indent" });
  await expect(indentButton).toBeEnabled();
  await indentButton.click();
  await expect(editor.locator("li li")).toHaveText("second");
  await expect(editor).toBeFocused();

  const outdentButton = toolbar.getByRole("button", { name: "Outdent" });
  await outdentButton.click();
  await expect(editor.locator("li li")).toHaveCount(0);
  await expect(editor.locator("ul > li")).toHaveText(["first", "second"]);
  await expect(editor).toBeFocused();
});

test("the Reference toolbar button inserts the same `[[` trigger a hand-typed one does, and opens the picker", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await editor.pressSequentially("see ");

  await toolbar.getByRole("button", { name: "Reference" }).click();
  await expect(editor).toContainText("see [[");
  await expect(page.getByRole("listbox", { name: "Days" })).toBeVisible();
  await expect(editor).toBeFocused();
});

test("the undo and redo toolbar buttons revert and restore an edit, and are disabled when there is nothing to act on", async ({
  page,
}) => {
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  const undoButton = toolbar.getByRole("button", { name: "Undo" });
  const redoButton = toolbar.getByRole("button", { name: "Redo" });
  await expect(undoButton).toBeDisabled();
  await expect(redoButton).toBeDisabled();

  await editor.pressSequentially("hello");
  await expect(undoButton).toBeEnabled();

  await undoButton.click();
  await expect(editor).not.toContainText("hello");
  await expect(redoButton).toBeEnabled();
  await expect(editor).toBeFocused();

  await redoButton.click();
  await expect(editor).toContainText("hello");
  await expect(editor).toBeFocused();
});

test("Mod-b, Mod-i, Mod-Shift-x and Mod-e apply their marks from the keyboard, with no toolbar involved", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("word");
  await editor.press("ControlOrMeta+a");

  await editor.press("ControlOrMeta+b");
  await expect(editor.locator("strong")).toHaveText("word");

  await editor.press("ControlOrMeta+i");
  await expect(editor.locator("em")).toHaveText("word");

  // UpNote's own verified chord for the same action
  // (meologue-parity-docs/upnote-macos-detail.md, "Cmd+Shift+X").
  await editor.press("ControlOrMeta+Shift+x");
  await expect(editor.locator("s")).toHaveText("word");

  await editor.press("ControlOrMeta+e");
  await expect(editor.locator("code")).toHaveText("word");
});

test("Mod-Shift-Enter toggles a checkbox done from the keyboard, and never sends", async ({
  page,
}) => {
  const body = uniqueEntryBody("composer-toggle-checkbox-chord");
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially(`- [ ] ${body}`);

  const checkbox = editor.locator('input[type="checkbox"]');
  await expect(checkbox).not.toBeChecked();

  await editor.press("ControlOrMeta+Shift+Enter");
  await expect(checkbox).toBeChecked();

  await editor.press("ControlOrMeta+Shift+Enter");
  await expect(checkbox).not.toBeChecked();

  // `isSubmitChord` already refuses any Enter with Shift held, on every
  // build (submit-chord.ts) — this chord is only free to mean something
  // else BECAUSE of that, so this is the test that would catch either one
  // regressing into the other: nothing reached History.
  await expect(page.locator('[data-slot="bubble-body"]', { hasText: body })).toHaveCount(0);
});

test("the submit chord still sends, even with the format toolbar switched on", async ({ page }) => {
  const body = uniqueEntryBody("composer-toolbar-submit-chord");
  await page.goto("/composer");
  await expectFormatToolbarVisible(page);
  const editor = composerField(page);
  await editor.pressSequentially(body);
  await editor.press("ControlOrMeta+Enter");

  await expect(page.getByText(body)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Issue #165: the `/` menu. composer-slash.test.ts already proves
// `deriveSlashMenu`/`filterSlashItems`/`buildSlashMenuItems` directly
// against plain strings (ADR 0044: jsdom cannot mount a ProseMirror
// `EditorView` at all). What can only be proven here, in a real browser, is
// that the ProseMirror-side plugin wiring (composer-editor.ts's
// `slashPlugin`) and composer.tsx's own keyboard handling actually produce
// the behaviour that pure logic describes — real keystrokes, real caret
// position, and the mutual-exclusion with the `[[` picker ADR 0046 records.
// ---------------------------------------------------------------------------

test("/ at the very start of a block opens the slash menu, offering all eight items", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("/");

  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveText([
    "Checklist",
    "Bullet list",
    "Numbered list",
    "Bold",
    "Italic",
    "Strikethrough",
    "Code",
    "Reference",
  ]);
});

test("/ typed immediately after whitespace also opens the slash menu", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("buy milk /");

  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
});

test("/ never opens the slash menu mid-word — and/or types cleanly, with no menu ever appearing", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  const listbox = page.getByRole("listbox", { name: "Commands" });

  // The "/" in "and/or" sits directly after "d" — never at a block start
  // and never after whitespace — so the menu must not appear at any point
  // while typing straight through it, character by character (this is the
  // ticket's own headline example, and the whole reason Obsidian's
  // position-gated rule was chosen over UpNote's fire-anywhere one).
  await editor.pressSequentially("and/or");
  await expect(listbox).toBeHidden();
  await expect(editor).toContainText("and/or");
});

test("the slash menu narrows to the typed query as it's typed — /che matches only Checklist", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("/che");

  await expect(page.getByRole("option")).toHaveText(["Checklist"]);
});

test("the slash menu's filter matches a substring in the MIDDLE of a label, not just a prefix", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  // "list" is a substring of "Checklist", "Bullet list" AND "Numbered
  // list" — none of the three STARTS with it, so all three matching proves
  // this is unanchored substring matching, not a prefix match. Also proves
  // case-insensitivity, since the query is typed here in lower case against
  // mixed-case labels.
  await editor.pressSequentially("/list");

  await expect(page.getByRole("option")).toHaveText(["Checklist", "Bullet list", "Numbered list"]);
});

test("the slash menu's filter is accent-insensitive", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  // No letter in "Reference" itself carries an accent — this only matches
  // because the accent is stripped from the QUERY before comparing.
  await editor.pressSequentially("/réf");

  await expect(page.getByRole("option")).toHaveText(["Reference"]);
});

test("a space typed after / dismisses the slash menu and leaves the typed text exactly where it is", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  const listbox = page.getByRole("listbox", { name: "Commands" });

  await editor.pressSequentially("/bo");
  await expect(listbox).toBeVisible();
  await editor.pressSequentially(" ld");

  await expect(listbox).toBeHidden();
  // Dismissing never touches the document — the reader was writing, and
  // the menu interrupted them, not the other way round.
  await expect(editor).toContainText("/bo ld");
});

test("a query that matches nothing dismisses the slash menu outright, leaving the query text untouched", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  const listbox = page.getByRole("listbox", { name: "Commands" });

  await editor.pressSequentially("/che");
  await expect(listbox).toBeVisible();
  // "chk" matches nothing — this is a SUBSTRING filter, not a fuzzy one, so
  // narrowing "che" to "chk" loses the one match "che" already had rather
  // than keeping it via a skipped-character match.
  await editor.pressSequentially("k");

  await expect(listbox).toBeHidden();
  await expect(editor).toContainText("/chek");
});

test("arrow keys move the highlighted row and wrap at both ends", async ({ page }) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("/");

  const options = page.getByRole("option");
  await expect(options).toHaveCount(8);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  // Wraps UP from the first row straight to the last.
  await editor.press("ArrowUp");
  await expect(options.nth(7)).toHaveAttribute("aria-selected", "true");

  // Wraps back DOWN from the last row to the first.
  await editor.press("ArrowDown");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  await editor.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
});

test("Enter applies the highlighted command and removes the /query, the same action the toolbar's own button runs", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("buy milk /che");
  await expect(page.getByRole("option")).toHaveText(["Checklist"]);

  await editor.press("Enter");

  await expect(page.getByRole("listbox", { name: "Commands" })).toBeHidden();
  // The "/che" span is gone entirely — never left behind as text — and the
  // paragraph became a checklist item, the exact same
  // `checklist.run` (composer-commands.ts) the Checklist toolbar button
  // itself runs.
  await expect(editor).not.toContainText("/che");
  await expect(editor.locator('input[type="checkbox"]')).toBeVisible();
  await expect(editor.locator("li")).toContainText("buy milk");
});

test("choosing Reference from the slash menu hands off to the [[ picker, with no separate insertion path", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("see /ref");
  await expect(page.getByRole("option")).toHaveText(["Reference"]);

  await editor.press("Enter");

  // The Reference toolbar button test above already proves `reference.run`
  // types a literal `[[`; here that lands where "/ref" used to be, and the
  // SAME trigger-detection that opens the `[[` picker for hand-typed text
  // opens it here too, with nothing in this feature aware that it just
  // handed off from one menu to the other.
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeHidden();
  await expect(page.getByRole("listbox", { name: "Days" })).toBeVisible();
  await expect(editor).toContainText("see [[");
});

test("Escape dismisses the slash menu and leaves the typed text exactly where it is", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("/che");
  const listbox = page.getByRole("listbox", { name: "Commands" });
  await expect(listbox).toBeVisible();

  await editor.press("Escape");

  await expect(listbox).toBeHidden();
  await expect(editor).toContainText("/che");
});

test("[[ still opens the Reference picker, and the / menu and the [[ picker are never both open at once", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  const slashListbox = page.getByRole("listbox", { name: "Commands" });
  const referenceListbox = page.getByRole("listbox", { name: "Days" });

  // Typing "/" opens the slash menu first — its own query then grows to
  // "[[" as the next two characters land, and the instant that query
  // COMPLETES a Reference trigger, the Reference picker takes over and the
  // slash menu closes on that same keystroke (composer-editor.ts's
  // `slashPlugin`, and ADR 0046).
  await editor.pressSequentially("/");
  await expect(slashListbox).toBeVisible();
  await editor.pressSequentially("[[");

  await expect(referenceListbox).toBeVisible();
  await expect(slashListbox).toBeHidden();

  await editor.press("Escape");
  await expect(referenceListbox).toBeHidden();
});
