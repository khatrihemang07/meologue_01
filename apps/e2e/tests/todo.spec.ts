import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { openDestination } from "./helpers";

/**
 * Issue #168: Todo's Inbox, modelled on composer.spec.ts — add, complete
 * (with Undo), reorder, reload, and confirm what a reader did survives the
 * reload exactly. Every Task's content carries a random suffix, the same
 * `uniqueEntryBody` reasoning helpers.ts already gives Entries: this suite
 * runs its specs sequentially against one shared Server (playwright.config.ts's
 * `fullyParallel: false`), so a bare "buy milk" would collide with whatever
 * an earlier run of this same spec already left behind.
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
  const rows = page.locator("li[data-task-id]");
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
