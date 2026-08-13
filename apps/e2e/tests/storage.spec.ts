import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// The web app's SQLite/OPFS storage (ticket 21) — real persistence and the
// two behaviours that get deliberately worse on web, both of which must
// fail with a visible message rather than a blank page or crash.

test("an Entry survives a hard reload", async ({ page }) => {
  await page.goto("/");

  const body = uniqueEntryBody("reload");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  await page.reload();

  await expect(page.getByText(body)).toBeVisible();
});

test("a second tab in the same origin shows an explicit error, not a blank page", async ({
  page,
  context,
}) => {
  // Two Pages in one BrowserContext share storage — the same origin, same
  // partition — which is exactly what "two tabs" means for the OPFS pool
  // VFS (unlike sync.spec.ts's separate BrowserContexts, which stand in for
  // two separate Devices).
  await page.goto("/");
  const body = uniqueEntryBody("second-tab");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  const secondTab = await context.newPage();
  await secondTab.goto("/");

  await expect(secondTab.getByText(/already open in another tab/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(secondTab.getByPlaceholder("What's on your mind?")).toBeDisabled();

  await secondTab.close();
});
