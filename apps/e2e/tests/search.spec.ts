import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// Search's app bar (ticket 55, generalising ticket 39/54's earlier
// History-only box): the magnifier turns the app bar into a field in
// place, on both destinations — narrowing the thread with the query living
// in the URL rather than component state. "In place" is CONTEXT.md's own
// word for what Search does, and this is what makes the UI agree with it:
// before this ticket, searching meant navigating to a different route,
// which is exactly what the glossary says Search is not.

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

  // The magnifier expands the app bar into the field — it isn't there
  // until tapped (ticket 55's "in place" mode, as opposed to an
  // always-present box).
  await expect(page.getByRole("searchbox", { name: "Search History" })).toHaveCount(0);
  await page.getByRole("button", { name: "Search History" }).click();

  const search = page.getByRole("searchbox", { name: "Search History" });
  await search.fill("search-alpha");

  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);

  await search.fill("");

  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toBeVisible();
});

test("dismissing search restores the app bar and clears the narrowing", async ({ page }) => {
  const alpha = uniqueEntryBody("search-dismiss-alpha");
  const beta = uniqueEntryBody("search-dismiss-beta");

  await page.goto("/");
  await sendEntry(page, alpha);
  await sendEntry(page, beta);

  await page.getByRole("link", { name: "History" }).click();
  await page.getByRole("button", { name: "Search History" }).click();
  await page.getByRole("searchbox", { name: "Search History" }).fill("search-dismiss-alpha");

  await expect(page).toHaveURL(/\/history\?q=search-dismiss-alpha/);
  await expect(page.getByText(beta)).toHaveCount(0);

  await page.getByRole("button", { name: "Close search" }).click();

  // The bar is restored (title back, magnifier back) and the query is
  // gone from the URL — "dismissing restores the bar and clears the
  // narrowing" is ticket 55's acceptance criteria verbatim.
  await expect(page.getByRole("searchbox", { name: "Search History" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search History" })).toBeVisible();
  await expect(page).toHaveURL("/history");
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toBeVisible();
});

test("a reload with a query in the URL keeps the filter, and the field opens on its own", async ({
  page,
}) => {
  const alpha = uniqueEntryBody("search-reload-alpha");
  const beta = uniqueEntryBody("search-reload-beta");

  await page.goto("/");
  await sendEntry(page, alpha);
  await sendEntry(page, beta);

  await page.getByRole("link", { name: "History" }).click();
  await page.getByRole("button", { name: "Search History" }).click();
  await page.getByRole("searchbox", { name: "Search History" }).fill("search-reload-alpha");

  await expect(page).toHaveURL(/\/history\?q=search-reload-alpha/);
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);

  await page.reload();

  // No click needed after a reload — a query already in the URL is reason
  // enough for the app bar to come back up already in search mode.
  await expect(page.getByRole("searchbox", { name: "Search History" })).toHaveValue(
    "search-reload-alpha",
  );
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);
});

// Ticket 54 gave History a direct Settings action and gave Settings a
// direct link back to History (its persistent nav) — no more forced
// round trip through the Composer. Both of those are still bare "/..."
// links with no query string, though, so the `q` param itself doesn't
// survive the trip. This proves the search still comes back.
test("a search survives a round trip through Settings", async ({ page }) => {
  const alpha = uniqueEntryBody("search-settings-alpha");
  const beta = uniqueEntryBody("search-settings-beta");

  await page.goto("/");
  await sendEntry(page, alpha);
  await sendEntry(page, beta);

  await page.getByRole("link", { name: "History" }).click();
  await page.getByRole("button", { name: "Search History" }).click();
  await page.getByRole("searchbox", { name: "Search History" }).fill("search-settings-alpha");
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
  // Settings never grows a search affordance of its own (ADR 0008/0009 —
  // it must stay usable with no thread at all).
  await expect(page.getByRole("button", { name: "Search History" })).toHaveCount(0);

  await page.getByRole("link", { name: "History" }).click();

  await expect(page).toHaveURL(/\/history\?q=search-settings-alpha/);
  await expect(page.getByRole("searchbox", { name: "Search History" })).toHaveValue(
    "search-settings-alpha",
  );
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);
});

// Ticket 55's headline change: Search is no longer History-only. Typing
// into the Composer's own app-bar field narrows the same thread shown
// next to the Composer, without ever navigating to /history.
test("search also narrows the thread from the Composer, and carries over to History", async ({
  page,
}) => {
  const alpha = uniqueEntryBody("search-composer-alpha");
  const beta = uniqueEntryBody("search-composer-beta");

  await page.goto("/");
  await sendEntry(page, alpha);
  await sendEntry(page, beta);

  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toBeVisible();

  await page.getByRole("button", { name: "Search History" }).click();
  await page.getByRole("searchbox", { name: "Search History" }).fill("search-composer-alpha");

  await expect(page).toHaveURL(/\/\?q=search-composer-alpha/);
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);

  // The Nav link to History is a bare "/history" with no query string —
  // the sessionStorage backup (use-history-search.ts) is what carries the
  // same search across, same mechanism that already carried it through a
  // round trip through Settings above.
  await page.getByRole("link", { name: "History" }).click();

  await expect(page).toHaveURL(/\/history\?q=search-composer-alpha/);
  await expect(page.getByRole("searchbox", { name: "Search History" })).toHaveValue(
    "search-composer-alpha",
  );
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);
});
