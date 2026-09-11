import { expect, test } from "@playwright/test";
import { entrySchema } from "../../web/src/lib/entry-schema";
import { entryDocumentToCanonical } from "../../web/src/lib/parity/canonical";
import { PARITY_FIXTURE } from "../../web/src/lib/parity/parity-fixture";
import { composerField } from "./helpers";

/**
 * Issue #230's replay suite: for every row in `PARITY_FIXTURE`
 * (apps/web/src/lib/parity/parity-fixture.ts), open a blank Composer,
 * replay the row's own keystroke script through a real `pressSequentially`
 * — never `.fill()`, which bypasses the `beforeinput`/`input` events
 * `prosemirror-inputrules` reads (helpers.ts's own `composerField` comment,
 * ADR 0044) — and compare the resulting document's canonical form against
 * the row's `expected`. jsdom cannot mount a live ProseMirror `EditorView`
 * at all (ADR 0044's own "Tests" section: no `Range`, no `Selection`, no
 * meaningful `getBoundingClientRect`), which is the whole reason this suite
 * lives here in `apps/e2e` and not beside `entry-document.test.ts` in
 * vitest.
 *
 * **This ticket lands red on purpose.** A row with `divergence: "none"`
 * asserts genuine parity — `expected` IS what `upnote` observed — and where
 * this Composer does not yet behave that way (Shift+Enter inside a list
 * item still splitting into a new item instead of a soft break; Tab on a
 * list's first item falling through to native focus navigation instead of
 * nesting), the row fails. That is this ticket's own deliverable, not a
 * bug in the suite: later tickets fix the behaviour, not this fixture.
 *
 * **Deliberately not importing `test`/`expect` from `./fixtures`.** Every
 * other spec in this suite does, for `resetServer`'s autouse `docker exec`
 * truncation of the shared Postgres tables (fixtures.ts's own comment) —
 * necessary there because those specs Send real Entries through a real
 * Server. Nothing in this file ever calls `sendEntry`/`openDestination`
 * against a Server at all; every row only types into the Composer field
 * and reads its own live document back. Importing `./fixtures` here would
 * add a real dependency on the shared Postgres container for a suite that
 * never touches it.
 *
 * **Reading the live document.** `entryMarkdownToDocument`/
 * `entryDocumentToCanonical` (apps/web/src/lib) are plain functions with no
 * DOM in them, but there is no export anywhere in `composer.tsx` that hands
 * a test the live `EditorView`'s own document — adding one is out of this
 * ticket's own file-ownership scope, and would be new API surface on a
 * component for a test's sake alone. `prosemirror-view` already exposes
 * exactly this, undocumented but real: every `ViewDesc` sets
 * `dom.pmViewDesc = this` on construction (`prosemirror-view`'s own
 * `ViewDesc` constructor), and the outermost one — the one attached to the
 * `EditorView`'s own root `dom` element, which `composerField` already
 * locates — carries `.node`, the current document. `readComposerDocJSON`
 * below reads exactly that, the same property prosemirror-dev-tools and
 * similar inspection tools already rely on, and hands back plain JSON —
 * the only shape that can cross the page/Node.js boundary at all — which
 * `entrySchema.nodeFromJSON` then turns back into a real `Node` this file
 * runs `entryDocumentToCanonical` against, in Node.js, not in the page.
 */

async function readComposerDocJSON(page: import("@playwright/test").Page): Promise<unknown> {
  const editor = composerField(page);
  return editor.evaluate((el) => {
    const desc = (el as unknown as { pmViewDesc?: { node?: { toJSON(): unknown } } }).pmViewDesc;
    if (desc?.node === undefined) {
      throw new Error(
        "composer-parity: no ProseMirror pmViewDesc found on the composer field — " +
          "the field may not have mounted yet, or prosemirror-view's own internal " +
          "expando property this suite depends on has changed shape.",
      );
    }
    return desc.node.toJSON();
  });
}

/**
 * The fixture's `settleCaretToLineStart` step, which has to MOVE the caret to
 * the start of the line and then wait for that move to land — both halves, not
 * just the wait. An earlier version of this function only waited, which made
 * every row whose premise is "caret at the very start of the item's own text"
 * silently replay with the caret still at the END: Backspace then deleted the
 * last character instead of unwrapping the item, and the row failed with
 * `"task"` read back as `"tas"` — a harness defect wearing the costume of a
 * real parity gap, which is precisely the failure mode this suite exists to
 * prevent.
 *
 * The wait is still necessary and is the hazard `composer.spec.ts`'s own
 * `caretToStartOfLine` documents at length: a caret move reaches ProseMirror's
 * state a task AFTER the keypress that caused it, so a command reading the
 * selection immediately afterward (Backspace's `liftAtStartOfListItem`, Tab's
 * `sinkListItem`) can read a stale one. Polling the DOM selection's own
 * `anchorOffset` to 0 before that fixed pause is what makes the move
 * observable rather than assumed.
 */
async function settleCaretToLineStart(
  page: import("@playwright/test").Page,
  editor: ReturnType<typeof composerField>,
): Promise<void> {
  // Wait for whatever caret-moving key preceded this step (an ArrowUp, in the
  // first-item-Tab row) to have actually landed in ProseMirror's state before
  // pressing Home. Without this the two races: Home applies to the line the
  // caret has not left yet, the row nests the wrong item, and the failure is
  // intermittent — it passed in isolation and failed in a full run, which is
  // exactly the shape that gets mistaken for a real defect.
  await page.waitForTimeout(50);
  await editor.press("Home");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const selection = window.getSelection();
        return selection === null ? -1 : selection.anchorOffset;
      }),
    )
    .toBe(0);
  await page.waitForTimeout(50);
}

async function caretOffset(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    return selection === null ? -1 : selection.anchorOffset;
  });
}

async function replay(
  page: import("@playwright/test").Page,
  keystrokes: (typeof PARITY_FIXTURE)[number]["keystrokes"],
): Promise<void> {
  const editor = composerField(page);
  await editor.click();
  for (const step of keystrokes) {
    if (step.kind === "type") {
      await editor.pressSequentially(step.text);
    } else if (step.kind === "key") {
      const times = step.times ?? 1;
      for (let i = 0; i < times; i += 1) {
        // A horizontal caret move is CONFIRMED, not merely waited on. The
        // hazard `composer.spec.ts`'s own `pressEnterUntil` comment names —
        // a keypress fired while ProseMirror's DOMObserver has not yet
        // flushed the previous one's mutation is simply LOST — makes a fixed
        // delay the wrong instrument: measured over 10 consecutive full runs,
        // a 30ms beat still dropped one of the five ArrowLefts in
        // `enter-mid-text-splits-item-into-sibling` 3 times out of 10, so
        // Enter split at the wrong offset. Polling the offset to the value
        // this press should have produced retries the press itself rather
        // than assuming it landed.
        // `ArrowLeft` is the only horizontal caret key this fixture's own
        // `KeyName` union carries; add a sibling branch here if it ever gains
        // another rather than widening this condition speculatively.
        if (step.key === "ArrowLeft") {
          const delta = -1;
          const before = await caretOffset(page);
          await expect
            .poll(async () => {
              const now = await caretOffset(page);
              if (now !== before + delta) {
                await editor.press(step.key);
              }
              return now;
            })
            .toBe(before + delta);
        } else {
          await editor.press(step.key);
          await page.waitForTimeout(30);
        }
      }
    } else {
      await settleCaretToLineStart(page, editor);
    }
  }
}

test.describe("composer / UpNote parity", () => {
  const replayableRows = PARITY_FIXTURE.filter((row) => row.replayable !== false);
  const skippedRows = PARITY_FIXTURE.filter((row) => row.replayable === false);

  for (const row of replayableRows) {
    test(row.id, async ({ page }) => {
      await page.goto("/composer");
      await replay(page, row.keystrokes);

      const json = await readComposerDocJSON(page);
      const actual = entryDocumentToCanonical(entrySchema.nodeFromJSON(json));

      expect(actual).toEqual(row.expected);
    });
  }

  // Not replayed — see each row's own `reason` in parity-fixture.ts and the
  // rendered doc (docs/reference/composer-parity.md) for why. Listed as
  // `test.fixme` rather than silently omitted, so the suite's own test
  // count still names every row the fixture holds.
  for (const row of skippedRows) {
    test.fixme(`${row.id} (not replayable — see parity-fixture.ts)`, async () => {
      // Intentionally empty.
    });
  }

  test("the fixture itself is non-trivial", () => {
    expect(PARITY_FIXTURE.length).toBeGreaterThan(20);
  });
});
