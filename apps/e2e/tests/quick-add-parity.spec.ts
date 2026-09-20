import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openDestination } from "./helpers";

function uniqueTaskContent(label: string): string {
  return `${label} ${randomUUID()}`;
}

async function openDesktopQuickAdd(page: Page): Promise<Locator> {
  await page.keyboard.press("q");
  const quickAdd = page.getByRole("dialog", { name: "Quick Add" });
  await expect(quickAdd).toBeVisible();
  return quickAdd;
}

test.describe("desktop Quick Add", () => {
  test.skip(({ isMobile }) => isMobile, "desktop-only shell behavior");

  test.beforeEach(async ({ page }) => {
    await openDestination(page, "Todo");
    await expect(page).toHaveURL("/todo/inbox");
  });

  test("a real pointer click rejects the whole highlighted match without changing its text", async ({
    page,
  }) => {
    const quickAdd = await openDesktopQuickAdd(page);
    const editor = quickAdd.getByLabel("Task name", { exact: true });
    await editor.fill("next week");

    const highlighted = editor.locator('[data-highlighted-match="true"]');
    await expect(highlighted).toHaveText("next week");

    // Issue #374 removed `DialogPortal` from the non-touch shell
    // (`quick-add-dialog.tsx`): this composer now renders in place inside
    // `todo-page.tsx`'s own scrollable Shell (`shell.tsx`'s own
    // `overflow-y-auto` pane) rather than under `document.body` as a
    // fixed-position overlay. `boundingBox()`, unlike a locator's own
    // `click()`, never scrolls its target into view first — on a Shell
    // that already has scrolled content above the composer, an
    // unscrolled read here would hand `page.mouse` coordinates for
    // whatever happens to sit at that offset instead, silently turning
    // this into a no-op click on the wrong element rather than a failure.
    await highlighted.scrollIntoViewIfNeeded();
    const box = await highlighted.boundingBox();
    if (!box) {
      throw new Error("expected the highlighted natural-language match to have a box");
    }

    // ProseMirror resolves clicks from the browser's mousedown sequence.
    // element.click()/dispatchEvent("click") would never exercise its
    // handleClick prop and would let this regression pass silently.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    await expect(editor).toHaveText("next week");
    await expect(editor.locator('[data-highlighted-match="true"]')).toHaveCount(0);
    await expect(editor.locator('[data-testid="natural-language-match"]')).toHaveText("next week");
  });

  test("a multi-line clipboard paste asks before adding one task per line", async ({ page }) => {
    const first = uniqueTaskContent("pasted-first");
    const second = uniqueTaskContent("pasted-second");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    const quickAdd = await openDesktopQuickAdd(page);
    const editor = quickAdd.getByLabel("Task name", { exact: true });
    await editor.click();
    await page.evaluate(
      ([firstLine, secondLine]) => navigator.clipboard.writeText(`${firstLine}\n${secondLine}`),
      [first, second],
    );
    await page.keyboard.press("ControlOrMeta+v");

    const confirmation = page.getByRole("dialog", { name: "Add 2 tasks?" });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText("Each line from your pasted text")).toBeVisible();
    await confirmation.getByRole("button", { name: "Add 2 tasks", exact: true }).click();

    await expect(confirmation).toHaveCount(0);
    await expect(page.getByText(first, { exact: true })).toBeVisible();
    await expect(page.getByText(second, { exact: true })).toBeVisible();
  });

  test("submitting closes the desktop composer", async ({ page }) => {
    const content = uniqueTaskContent("desktop-submit");
    const quickAdd = await openDesktopQuickAdd(page);
    await quickAdd.getByLabel("Task name", { exact: true }).fill(content);

    await quickAdd.getByRole("button", { name: "Add task", exact: true }).click();

    await expect(page.getByRole("dialog", { name: "Quick Add" })).toHaveCount(0);
    await expect(page.getByText(content, { exact: true })).toBeVisible();
  });
});

test.describe("touch Quick Add", () => {
  test.skip(({ isMobile }) => !isMobile, "touch-shell behavior runs in the Pixel 7 project");

  test("the FAB opens the touch sheet and submitting keeps it open with a cleared title", async ({
    page,
  }) => {
    const content = uniqueTaskContent("touch-submit");
    await openDestination(page, "Todo");
    await expect(page).toHaveURL("/todo/inbox");

    await page.getByRole("button", { name: "Quick add", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Quick Add" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Add task", exact: true })).toHaveCount(0);

    const editor = sheet.getByLabel("Task name", { exact: true });
    await editor.fill(content);
    await sheet.getByRole("button", { name: "Add task", exact: true }).click();

    await expect(sheet).toBeVisible();
    await expect(editor).toHaveText("");
    await expect(sheet.getByRole("button", { name: "Add task", exact: true })).toHaveCount(0);
    await expect(page.getByText('Added to "Inbox"', { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show", exact: true })).toBeVisible();
  });
});
