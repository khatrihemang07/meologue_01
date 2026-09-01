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
  // The pointer has to land in "first"'s TOP half: `dropIndexForPointer`'s
  // own midpoint rule reads the bottom half as "after this row," which is
  // exactly where "second" already sits — landing there would be a
  // correct no-op, not the swap this test is asserting.
  const endX = firstBox.x + firstBox.width / 2;
  const endY = firstBox.y + firstBox.height / 4;

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

  await page.getByRole("button", { name: `Delete "${content}"` }).click();
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
