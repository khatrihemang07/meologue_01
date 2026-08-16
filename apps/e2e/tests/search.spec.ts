import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// History's search box (ticket 39) — narrows the list in place to Entries
// whose text matches, with the query living in the URL rather than
// component state.

test("search narrows History to a matching Entry, and clearing it restores both", async ({
  page,
}) => {
  const alpha = uniqueEntryBody("search-alpha");
  const beta = uniqueEntryBody("search-beta");

  await page.goto("/");
  await sendEntry(page, alpha);
  await sendEntry(page, beta);

  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL("/history");
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search History" });
  await search.fill("search-alpha");

  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);

  await search.fill("");

  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toBeVisible();
});

test("a reload with a query in the URL keeps the filter", async ({ page }) => {
  const alpha = uniqueEntryBody("search-reload-alpha");
  const beta = uniqueEntryBody("search-reload-beta");

  await page.goto("/");
  await sendEntry(page, alpha);
  await sendEntry(page, beta);

  await page.getByRole("link", { name: "History" }).click();
  await page.getByRole("searchbox", { name: "Search History" }).fill("search-reload-alpha");

  await expect(page).toHaveURL(/\/history\?q=search-reload-alpha/);
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);

  await page.reload();

  await expect(page.getByRole("searchbox", { name: "Search History" })).toHaveValue(
    "search-reload-alpha",
  );
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);
});

// History has no direct link to Settings — the only route is Back ->
// Composer -> Settings -> Back -> Composer -> History, and every link on
// that path is a bare "/..." with no query string, so the `q` param itself
// doesn't survive the round trip. This proves the search still comes back.
test("a search survives a round trip through Settings", async ({ page }) => {
  const alpha = uniqueEntryBody("search-settings-alpha");
  const beta = uniqueEntryBody("search-settings-beta");

  await page.goto("/");
  await sendEntry(page, alpha);
  await sendEntry(page, beta);

  await page.getByRole("link", { name: "History" }).click();
  await page.getByRole("searchbox", { name: "Search History" }).fill("search-settings-alpha");
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);

  await page.getByRole("link", { name: /back/i }).click();
  await expect(page).toHaveURL("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
  await page.getByRole("link", { name: /back/i }).click();
  await expect(page).toHaveURL("/");
  await page.getByRole("link", { name: "History" }).click();

  await expect(page).toHaveURL(/\/history\?q=search-settings-alpha/);
  await expect(page.getByRole("searchbox", { name: "Search History" })).toHaveValue(
    "search-settings-alpha",
  );
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);
});
