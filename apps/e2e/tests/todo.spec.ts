import { randomUUID } from "node:crypto";
import { SERVER_A_DATABASE } from "../servers";
import { expect, test } from "./fixtures";
import { openDestination, waitForTaskOrder, waitForTaskParent } from "./helpers";

/**
 * Issue #168: Todo's Inbox, modelled on composer.spec.ts — add, complete
 * (with Undo), reorder, reload, and confirm what a reader did survives the
 * reload exactly. Every Task's content carries a random suffix, the same
 * `uniqueEntryBody` reasoning helpers.ts already gives Entries: this suite
 * runs its specs sequentially against one shared Server (playwright.config.ts's
 * `fullyParallel: false`), so a bare "buy milk" would collide with whatever
 * an earlier run of this same spec already left behind.
 *
 * Issue #190: that same shared-Server fact meant the first test below used
 * to count EVERY `li[data-task-id]` on the page, trusting that nothing
 * other than this test had ever put one there — a trust an earlier spec
 * file (composer.spec.ts, promoting a checkbox line into a Task) broke.
 * `fixtures.ts`'s `resetTasks` fixture now makes that trust actually true
 * (no Task survives from a previous test, in this file or any other), but
 * the count below is scoped to `first`/`second` by their own random content
 * regardless — so this test reads as "the two Tasks I just added," which is
 * what it always meant, not "however many Tasks happen to exist."
 */
function uniqueTaskContent(label: string): string {
  return `${label} ${randomUUID()}`;
}

async function addTask(page: import("@playwright/test").Page, content: string): Promise<void> {
  await page.getByLabel("Add a Task").fill(content);
  await page.getByRole("button", { name: "Add" }).click();
}

test("adding, completing (with Undo), reordering and reloading all leave Todo exactly where the reader left it", async ({
  page,
}) => {
  const first = uniqueTaskContent("todo-first");
  const second = uniqueTaskContent("todo-second");

  await openDestination(page, "Todo");
  await expect(page).toHaveURL("/todo/inbox");

  await addTask(page, first);
  await expect(page.getByText(first)).toBeVisible();
  await addTask(page, second);
  await expect(page.getByText(second)).toBeVisible();

  // Added in order, appended each time (use-tasks.ts's own addTask) — the
  // first Task added sorts before the second.
  //
  // Scoped to `first`/`second` by their own random content, not a bare
  // `li[data-task-id]` — issue #190. `resetTasks` (fixtures.ts) already
  // guarantees these are the only two Tasks that exist when this runs, but
  // the count itself should still read as "the Tasks THIS test added,"
  // not "however many happen to be on the page" — that was the assertion's
  // actual bug, independent of what fixed the leak that exposed it.
  const rows = page.locator("li[data-task-id]", { hasText: new RegExp(`${first}|${second}`) });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(first);
  await expect(rows.nth(1)).toContainText(second);

  // Completing raises the same undo-toast pattern
  // register-service-worker.web.ts's own update prompt uses — undoing
  // through it is an ordinary uncomplete(), not a resurrection (ADR 0047),
  // so the Task lands right back where its own orderKey already puts it.
  await page.getByRole("checkbox", { name: first }).click();
  await expect(page.getByRole("checkbox", { name: first })).toHaveCount(0);
  await expect(page.getByText(`Completed "${first}"`)).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("checkbox", { name: first })).toBeVisible();
  await expect(rows.nth(0)).toContainText(first);
  await expect(rows.nth(1)).toContainText(second);

  // A drop lands the dragged Task *before* the row it was dropped on —
  // that is what todo-page.tsx's `commitDrop` computes and what the row's
  // top-edge indicator draws. So the swap here has to drag "second" onto
  // "first"'s row, not the other way round: dragging "first" onto "second"
  // would ask for an order it is already in, and correctly change nothing.
  // Writing it the wrong way round is a test that passes for the wrong
  // reason on a broken implementation, which is why the direction is
  // spelled out rather than left to look arbitrary.
  //
  // Driven through `page.mouse`, not Playwright's `dragTo` — `dragTo`
  // drives the browser's native HTML5 drag-and-drop, which is exactly the
  // mechanism issue #168's own follow-up replaced: Android WebView never
  // synthesises `dragstart` from touch input, so the recogniser this page
  // uses now has to be a Pointer Events one, and the only honest way to
  // exercise it here is the same down/move/up sequence a real pointer
  // produces. The gesture has to originate on the grip handle, same as a
  // real reader's finger — a pointerdown anywhere else on the row leaves
  // the list scrolling normally instead.
  const firstRow = page.locator("li[data-task-id]", { hasText: first });
  const secondRow = page.locator("li[data-task-id]", { hasText: second });
  const secondHandle = secondRow.getByTestId("task-drag-handle");

  const secondHandleBox = await secondHandle.boundingBox();
  const firstBox = await firstRow.boundingBox();
  if (!secondHandleBox || !firstBox) {
    throw new Error("expected both rows' grip handle and bounding box to be measurable");
  }

  const startX = secondHandleBox.x + secondHandleBox.width / 2;
  const startY = secondHandleBox.y + secondHandleBox.height / 2;
  // The pointer has to land well inside "first"'s TOP EDGE BAND.
  // `dropIndexForPointer` reads a row in three bands since issue #171: the
  // top and bottom quarters reorder, and the middle half *nests* the
  // dragged Task under this one. So there are two ways to get this wrong,
  // and both look like a passing drag until you read the result — the
  // bottom band means "after this row," which is where "second" already
  // sits (a correct no-op, not the swap being asserted), and the middle
  // band changes the Task's parent rather than its order.
  //
  // `height / 8`, not `height / 4`: a quarter is exactly the band boundary,
  // and landing on a boundary is how this test failed once already.
  const endX = firstBox.x + firstBox.width / 2;
  const endY = firstBox.y + firstBox.height / 8;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Real intermediate moves, not one jump straight to the target — the
  // recogniser only ever sees motion through genuine `pointermove` events,
  // the same way `use-swipe-actions.ts`'s own gesture does.
  await page.mouse.move(startX, (startY + endY) / 2, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();

  await expect(rows.nth(0)).toContainText(second);
  await expect(rows.nth(1)).toContainText(first);

  // A reload re-boots from scratch and pulls whatever Sync hands it back —
  // waiting for the Server's own copy to agree with the swap first is the
  // same "wait for the causally-later, externally-checkable condition"
  // discipline `waitForTaskCompleted` already uses for a completion
  // (`waitForTaskOrder`'s own doc comment, helpers.ts). Without it, this
  // step is a real, if occasional, race: reproduced on a full-file run at
  // load ~10-13 — the drop rendering correctly, then a reload reverting to
  // the pre-drop order because an in-flight Sync pull still carried it.
  await waitForTaskOrder(second, first, SERVER_A_DATABASE);

  await page.reload();

  // The order survives — it was written to the Task's own row, not held in
  // component state — and so does the earlier Undo: neither Task is back
  // in the completed list.
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(second);
  await expect(rows.nth(1)).toContainText(first);
  await expect(page.getByRole("checkbox", { name: first })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: second })).not.toBeChecked();
});

// Deleting is destructive and goes behind the shared ConfirmDialog
// (sessions-page.tsx/history.tsx's own pattern) — a Task Add followed by a
// Delete-and-confirm must leave the Inbox exactly as if it were never
// added, surviving a reload the same way the test above proves an
// addition and a reorder do.
test("deleting a Task requires confirmation, and the deletion survives a reload", async ({
  page,
}) => {
  const content = uniqueTaskContent("todo-delete");

  await openDestination(page, "Todo");
  await addTask(page, content);
  await expect(page.getByText(content)).toBeVisible();

  // Issue #178 moved Delete off the row's own hover actions into the
  // "More actions" (⋯) menu, alongside the rest of the full command set —
  // task-row.test.tsx's own equivalent unit test has the fuller reasoning.
  await page.getByRole("button", { name: `More actions for "${content}"` }).click();
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  // Scoped to the dialog, not `page.getByText(content)`: the Task's row is
  // still rendered behind the dialog, so an unscoped match resolves to two
  // elements and fails strict mode. What this assertion is actually for is
  // that the confirmation *names the Task being destroyed* rather than
  // asking a generic question — so it has to look inside the dialog.
  await expect(confirm).toContainText(content);

  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(content)).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(content)).toHaveCount(0);
});

// Issue #192: a sub-task's own `<ul>` has to be nested *inside* its parent
// row's own `<li>` — a `ul` may hold only `li` (plus `script`/`template`) —
// and, critically, that relationship has to actually reach a real
// accessibility tree, not just look right in the raw DOM. jsdom (this
// suite's own unit tests, task-tree.test.tsx/task-row.test.tsx) never lays
// anything out or computes an AX tree at all, so this is the one place
// either claim gets checked against what a browser — and so a screen
// reader — actually sees.
//
// Reparenting here goes through a **drag** into the target row's own
// middle nest band — the identical gesture the reorder test above drives,
// and the identical one task-tree.test.tsx's own "dropping in a row's own
// middle band reparents the dragged Task under it" unit test exercises
// against a fake DOM — not the keyboard path (`Alt`+`ArrowRight`). That
// was this test's own first version, and it was genuinely unreliable: on
// separate full-file runs, at a comparable, non-degraded load average,
// `Alt`+`ArrowRight` sometimes did nothing at all, even routed through
// Playwright's own atomic `locator.press()` rather than a separate
// `.focus()` ahead of it (the standard fix for a focus race, applied and
// still not enough here — this file's own git history has the fuller
// account). Drag sidesteps whatever that race actually was: it never
// asks the browser to hold *keyboard* focus on a specific element across
// a gap at all, only *pointer capture* on the handle
// (`setPointerCapture`, task-tree.tsx's own `handlePointerDown`), which
// survives a re-render the way DOM focus does not. Keyboard reparenting
// is still a real acceptance criterion of #192 and still worth its own
// coverage — but a flaky assertion of it is worse than no assertion at
// all (this suite's own standing rule, issue #112), and this test's own
// job is proving the markup/AX-tree claim, not re-litigating which input
// path reaches `setTaskParent`; task-tree.test.tsx's own keyboard-indent
// unit tests already do that, deterministically, against a fake DOM.
test("a sub-task's own list nests inside its parent row's own <li>, and the accessibility tree agrees", async ({
  page,
}) => {
  const parent = uniqueTaskContent("todo-parent");
  const child = uniqueTaskContent("todo-child");

  await openDestination(page, "Todo");
  await addTask(page, parent);
  await expect(page.getByText(parent)).toBeVisible();
  await addTask(page, child);
  await expect(page.getByText(child)).toBeVisible();

  // Captured by `data-task-id`, not re-located by `hasText` later on — a
  // `hasText` filter on `li[data-task-id]` matches an `<li>`'s *entire
  // subtree* text, and once the reparent below lands, the child's own
  // `<li>` is a descendant of the parent's (that is the whole point of
  // this test), so the parent's `<li>` contains the child's text too.
  // `page.locator("li[data-task-id]", { hasText: child })` would then
  // resolve to two elements — the child's own row AND the parent's,
  // wrongly — a strict-mode violation, not a flake. `data-task-id` is
  // stable and unique regardless of where in the tree a row's `<li>` ends
  // up, so it is captured once, up front, while both Tasks are still
  // top-level siblings and `hasText` is still an unambiguous way to find
  // each one.
  const parentId = await page
    .locator("li[data-task-id]", { hasText: parent })
    .getAttribute("data-task-id");
  const childId = await page
    .locator("li[data-task-id]", { hasText: child })
    .getAttribute("data-task-id");
  expect(parentId).not.toBeNull();
  expect(childId).not.toBeNull();

  const parentRow = page.locator(`li[data-task-id="${parentId}"]`);
  const childRow = page.locator(`li[data-task-id="${childId}"]`);

  // Driven through `page.mouse`, not Playwright's `dragTo` — the identical
  // choice and the identical reason the reorder test above makes it
  // (issue #168's own follow-up: native HTML5 drag-and-drop never fires on
  // Android WebView, so the recogniser this app actually ships is a
  // Pointer Events one, and only a real down/move/up sequence exercises
  // it). The gesture originates on the *child's* own handle and ends in
  // the *parent's* own row.
  const childHandle = childRow.getByTestId("task-drag-handle");
  const childHandleBox = await childHandle.boundingBox();
  const parentBox = await parentRow.locator(":scope > [data-task-row-box]").boundingBox();
  if (!childHandleBox || !parentBox) {
    throw new Error("expected both rows' grip handle and bounding box to be measurable");
  }

  const startX = childHandleBox.x + childHandleBox.width / 2;
  const startY = childHandleBox.y + childHandleBox.height / 2;
  // Dead centre of the parent's own row — solidly inside its middle *nest*
  // band, not either edge quarter. `dropIndexForPointer` splits a row into
  // three bands (task-tree.tsx's own header comment): the top and bottom
  // quarters reorder ("insert before"/"insert after" this row), and only
  // the middle half nests the dragged Task under it. The reorder test
  // above sizes its own drop point off `height / 8` specifically to stay
  // *out* of this band; here landing inside it is the entire point, and
  // the row's own centre is as far from either edge boundary as this row
  // gets.
  const endX = parentBox.x + parentBox.width / 2;
  const endY = parentBox.y + parentBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Real intermediate moves, not one jump straight to the target — the
  // recogniser only ever sees motion through genuine `pointermove` events,
  // the same requirement the reorder test above already states.
  await page.mouse.move(startX, (startY + endY) / 2, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();

  // Wait for the Server's own copy to agree the reparent actually landed —
  // the same "wait for the causally-later, externally-checkable condition"
  // discipline `waitForTaskOrder` already gives the reorder test above,
  // applied here through `waitForTaskParent` (helpers.ts's own doc comment
  // on it). This is what turns a drop that somehow never reached its
  // target into a clear, named timeout right here, rather than the
  // confusing CSS-property mismatch several assertions later that an
  // earlier, keyboard-driven version of this test actually failed with.
  await waitForTaskParent(child, parent, SERVER_A_DATABASE);

  // The reparent actually landed on screen too — depth-2 indentation
  // (task-row.tsx's own `paddingLeft` formula, now read off
  // `[data-task-row-box]` rather than the `<li>` itself — that file's own
  // header comment on why) is the same "did this really happen" signal the
  // drag test above reads off row order.
  await expect(parentRow.locator(":scope > [data-task-row-box]")).toHaveCSS("padding-left", "12px");
  await expect(childRow.locator(":scope > [data-task-row-box]")).toHaveCSS("padding-left", "32px");

  // Criterion 1: the structural claim itself. Read directly off the real
  // DOM — the child's own nearest `<ul>` ancestor has to be a *child* of
  // the parent's own `<li>`, not a sibling of it (the pre-#192 shape:
  // `<ul><li>parent</li><ul><li>child</li></ul></ul>`, tolerated by
  // browsers but invalid HTML).
  //
  // Looked up by `data-task-id`, not `textContent.includes(...)` —
  // `document.querySelectorAll("li[data-task-id]")` in document order puts
  // the parent's own `<li>` *before* the child's, and the parent's `<li>`
  // now contains the child's text too (its subtree), so a `textContent`
  // search for the child would silently find the parent's `<li>` first
  // and never notice: `childListIsInsideParentLi` would then read the
  // *outer* `<ul>` as the child's nearest list and report `false`, not
  // throw. `data-task-id` is exact and immune to whatever text a row's
  // own descendants happen to carry.
  const structure = await page.evaluate(
    ({ parentTaskId, childTaskId }) => {
      const parentLi = document.querySelector(`li[data-task-id="${parentTaskId}"]`);
      const childLi = document.querySelector(`li[data-task-id="${childTaskId}"]`);
      if (!parentLi || !childLi) return null;
      const childList = childLi.closest("ul");
      return {
        childListIsInsideParentLi: childList !== null && childList.parentElement === parentLi,
        parentLiChildTags: Array.from(parentLi.children).map((el) => el.tagName),
      };
    },
    { parentTaskId: parentId, childTaskId: childId },
  );
  expect(structure).not.toBeNull();
  expect(structure?.childListIsInsideParentLi).toBe(true);
  expect(structure?.parentLiChildTags).toContain("UL");

  // Criterion 4: the accessibility tree — not the markup — actually
  // expresses the relationship. Playwright's own `ariaSnapshot()` (Chrome
  // DevTools' `Accessibility.getFullAXTree` underneath) serialises with a
  // 2-space indent per nesting level; a sibling `<ul>` (the pre-#192 bug)
  // would put "list:" at the *same* indent as the outer "list:"'s own
  // "listitem:" children, rather than nested one level inside one of
  // them. This was verified against the actual bug before this fix
  // shipped — the reader's own report has the full before/after.
  const outerList = page.locator("ul").filter({ has: page.getByText(parent, { exact: true }) });
  const snapshot = await outerList.first().ariaSnapshot();
  const lines = snapshot.split("\n");
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const outerListIndent = indentOf(lines[0] ?? "");
  const topLevelChildIndent = outerListIndent + 2;
  // Every "list:" line after the very first (the outer `<ul>` itself) has
  // to sit *deeper* than a top-level child of that outer list — i.e.
  // nested inside a `listitem`, never a sibling of one.
  const nestedListLines = lines.slice(1).filter((line) => line.trim() === "- list:");
  expect(nestedListLines.length).toBeGreaterThan(0);
  for (const line of nestedListLines) {
    expect(indentOf(line)).toBeGreaterThan(topLevelChildIndent);
  }
});

// Issue #185, ADR 0058: saving a Filter and opening it — criterion 1
// ("opening one shows what it matches") and criterion 7 ("a live preview
// shows what a query matches before it is saved") end to end, against a
// real Task added moments earlier through the ordinary Add field. `today`
// is typed as ordinary quick-add text (add-task-form.tsx's own smart-date
// recognition), not a Filter-specific setup step — this is what actually
// gives the new Task a real `date` of today for the Filter's own `today`
// flag to match, the same "considers a Date... when asking what is due"
// criterion 4 states.
test("saving a Filter and opening it shows what it matches, and both survive a reload", async ({
  page,
}) => {
  const taskLabel = uniqueTaskContent("todo-filter-task");
  const filterName = uniqueTaskContent("todo-filter-name");

  await openDestination(page, "Todo");
  await addTask(page, `${taskLabel} today`);
  // Quick-add strips the recognised "today" token out of content — the
  // row shows the bare label, dated today (../quick-add/'s own
  // `content` doc comment).
  await expect(page.getByText(taskLabel)).toBeVisible();

  await page.getByRole("link", { name: "Filters" }).click();
  await expect(page).toHaveURL("/todo/filters");

  await page.getByRole("link", { name: "New Filter" }).click();
  await expect(page).toHaveURL("/todo/filters/new");

  const saveButton = page.getByRole("button", { name: "Save" });
  await expect(saveButton).toBeDisabled();

  await page.getByRole("textbox", { name: "Filter name" }).fill(filterName);
  await page.getByRole("textbox", { name: "Filter query" }).fill("today");

  // Criterion 7: the live preview, before Save is ever clicked — the
  // just-added Task already shows up beneath the still-unsaved query.
  await expect(page.getByText(taskLabel)).toBeVisible();
  await expect(saveButton).toBeEnabled();

  await saveButton.click();

  // Saving navigates straight to the new Filter's own address (a real
  // uuid, not "new") — criterion 1's "opening one shows what it matches"
  // is the exact screen Save just landed on.
  await expect(page).toHaveURL(/\/todo\/filters\/(?!new$)[\w-]+$/);
  await expect(page.getByRole("textbox", { name: "Filter name" })).toHaveValue(filterName);
  await expect(page.getByRole("textbox", { name: "Filter query" })).toHaveValue("today");
  await expect(page.getByText(taskLabel)).toBeVisible();

  await page.reload();

  // Both the saved Filter and the Date it matches against survive —
  // neither lived only in this page's own component state.
  await expect(page.getByRole("textbox", { name: "Filter name" })).toHaveValue(filterName);
  await expect(page.getByRole("textbox", { name: "Filter query" })).toHaveValue("today");
  await expect(page.getByText(taskLabel)).toBeVisible();

  await page.getByRole("link", { name: "Filters" }).click();
  await expect(page.getByRole("link", { name: filterName })).toBeVisible();
});

// Criterion 6: a query this grammar cannot parse says so plainly, and
// Save is never offered for it — the reference implementation's own
// defect (silently blank, Save still enabled) this ticket was asked not
// to copy.
test("an unparseable Filter query shows the error plainly and never offers Save", async ({
  page,
}) => {
  await openDestination(page, "Todo");
  await page.getByRole("link", { name: "Filters" }).click();
  await page.getByRole("link", { name: "New Filter" }).click();

  await page.getByRole("textbox", { name: "Filter name" }).fill(uniqueTaskContent("bad-filter"));
  await page.getByRole("textbox", { name: "Filter query" }).fill("today & p1 | subtask");

  await expect(page.getByRole("alert")).toContainText(/parentheses/i);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});
