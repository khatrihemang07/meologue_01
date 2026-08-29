import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// The web app's SQLite/OPFS storage (ticket 21) — real persistence and the
// two behaviours that get deliberately worse on web, both of which must
// fail with a visible message rather than a blank page or crash.

test("an Entry survives a hard reload", async ({ page }) => {
  await page.goto("/composer");

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
  await page.goto("/composer");
  const body = uniqueEntryBody("second-tab");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  const secondTab = await context.newPage();
  // `/composer`, not `/`: ADR 0036 put the root screen outside
  // EntryStoreLayout so the list renders whether or not the store opens,
  // which means loading `/` would never attempt the second open this spec
  // exists to observe.
  await secondTab.goto("/composer");

  // Wording as of ticket 45: "tab" became "window" once installing the PWA
  // made an installed window plus a browser tab the normal way to end up
  // here, not just two tabs someone opened deliberately.
  await expect(secondTab.getByText(/already open in another window/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(secondTab.getByPlaceholder("What's on your mind?")).toBeDisabled();

  await secondTab.close();
});
