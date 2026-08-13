import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// Client-side routing (ticket 25) — real paths, not hash routing, which
// only works if the server serving the production build falls back to the
// app shell for a path it's never heard of. This is the one thing that's
// genuinely uncertain about the change, so it gets its own spec that loads
// /settings directly and hard-reloads on it, against the real Rust server.

test("/settings loads directly, survives a hard reload, and a back link returns to a working composer", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByText("Settings")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Settings")).toBeVisible();

  await page.getByRole("link", { name: /back/i }).click();
  await expect(page).toHaveURL("/");

  const body = uniqueEntryBody("routing");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();
});

test("the gear link on the history page navigates to Settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();

  await expect(page).toHaveURL("/settings");
  await expect(page.getByText("Settings")).toBeVisible();
});

// Unit tests already cover applyTheme/watchSystemTheme in isolation; what
// only a real page load can prove is that the class survives past a hard
// reload of the actual production build — i.e. that main.tsx really does
// apply it before first paint, from real localStorage, not a mock of it.
test("choosing Dark in Settings survives a hard reload", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Dark" }).click();

  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.reload();

  await expect(page.locator("html")).toHaveClass(/dark/);
});
