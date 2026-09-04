import type { Locator, Page } from "@playwright/test";
import { SERVER_A_DATABASE } from "../servers";
import { expect, test } from "./fixtures";
import {
  composerField,
  editEntryViaMenu,
  entryRow,
  entrySeq,
  sendEntry,
  uniqueEntryBody,
  waitForEntryId,
  waitForTaskCompleted,
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
  await editor.press("Enter");
  await editor.pressSequentially("[X] second");

  const boxes = editor.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(editor).not.toContainText("[");
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
 * The accessibility regression this ticket most explicitly guards against:
 * a Composer that swallows Tab unconditionally traps keyboard focus inside
 * itself (WCAG 2.1.2), unable to hand it back to the rest of the page. Tab
 * indents ONLY when the caret is inside a list item — `sinkListItem` has
 * nothing to sink in plain prose, returns `false`, and `listKeymap`'s own
 * comment on this binding records that `false` reaching
 * `prosemirror-keymap` here is what lets the browser's native Tab (move
 * focus to the next focusable element) run unopposed. The Send button is
 * the next focusable element after the field in composer.tsx's own DOM
 * order whenever the Composer isn't mid-edit, which this test isn't.
 */
test("Tab outside a list still moves focus out of the Composer, not swallowed as a keyboard trap", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  await editor.pressSequentially("plain prose, no list here");
  await expect(editor).toBeFocused();

  await editor.press("Tab");

  await expect(editor).not.toBeFocused();
  await expect(page.getByRole("button", { name: "Send" })).toBeFocused();
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

test("ticks a Task from the Day block, and the completion survives a reload", async ({ page }) => {
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
  await expect(
    page.getByTestId("day-tasks-row").locator("li", { hasText: body }).getByRole("checkbox"),
  ).toBeChecked();
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
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue(body);
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

/** Focuses the Composer and switches the format toolbar on — off by default (settings.ts), so most of the specs below need this first. */
async function enableFormatToolbar(page: Page): Promise<void> {
  const editor = composerField(page);
  await editor.click();
  await page.getByRole("button", { name: "Format toolbar" }).click();
}

test("the format toolbar is off by default, shows only while the Composer has focus once switched on, and the toggle survives a reload", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  const toggle = page.getByRole("button", { name: "Format toolbar" });

  // Off by default — UpNote's own equivalent also defaults off (settings.ts's
  // own comment) — so focusing the field alone shows nothing.
  await editor.click();
  await expect(toolbar).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Switching it on shows the row immediately, without blurring the editor
  // — the toggle button gets the same caret-preserving treatment as the
  // toolbar's own eleven buttons (composer.tsx's own comment on it), which
  // is what makes "immediately" true rather than "after clicking back in".
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toolbar).toBeVisible();
  await expect(editor).toBeFocused();

  // Blurring the Composer hides the row again — it shows only WHILE the
  // Composer has focus, independent of the setting itself, which is still
  // on underneath (the toggle's own `aria-pressed` doesn't move here).
  await page.getByRole("button", { name: "Send" }).focus();
  await expect(toolbar).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await editor.click();
  await expect(toolbar).toBeVisible();

  // The setting itself is a Device setting (settings.ts), not component
  // state — it survives a reload, the same way Accent/text size do
  // (settings.spec.ts's own "persisted the same way theme is" comment).
  await page.reload();
  await expect(page.getByRole("button", { name: "Format toolbar" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await composerField(page).click();
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
});

test("the bold, italic and code toolbar buttons apply their marks, reflect the caret's own pressed state, and never blur the editor", async ({
  page,
}) => {
  await page.goto("/composer");
  await enableFormatToolbar(page);
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
  await enableFormatToolbar(page);
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
  await enableFormatToolbar(page);
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
  await enableFormatToolbar(page);
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
  await enableFormatToolbar(page);
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
  await enableFormatToolbar(page);
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
  await enableFormatToolbar(page);
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

test("Mod-b, Mod-i and Mod-e apply their marks from the keyboard, with no toolbar involved", async ({
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
  await enableFormatToolbar(page);
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

test("/ at the very start of a block opens the slash menu, offering all seven items", async ({
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
  await expect(options).toHaveCount(7);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  // Wraps UP from the first row straight to the last.
  await editor.press("ArrowUp");
  await expect(options.nth(6)).toHaveAttribute("aria-selected", "true");

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
