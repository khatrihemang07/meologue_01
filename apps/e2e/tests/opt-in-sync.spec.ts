import type { Request } from "@playwright/test";
import { SERVER_A_URL } from "../servers";
import { expect, test } from "./fixtures";
import { openDestination, SYNC_TICK_MS, sendEntry, uniqueEntryBody } from "./helpers";

// ADR 0011: an unset Server URL means sync is off, not "attempt and fail" —
// verifiable as no network traffic. Every other spec in this suite runs
// with a Server URL seeded (playwright.config.ts's default storageState),
// so this is the one place a context is deliberately left unconfigured.

test.use({ storageState: { cookies: [], origins: [] } });

function countSyncRequests(onCount: (count: number) => void) {
  let count = 0;
  return (request: Request) => {
    if (request.url().endsWith("/v1/sync")) {
      onCount(++count);
    }
  };
}

test("no /v1/sync request is made while no Server URL is configured", async ({ page }) => {
  let syncRequests = 0;
  page.on(
    "request",
    countSyncRequests((count) => (syncRequests = count)),
  );

  await page.goto("/composer");
  await expect(page.getByPlaceholder("What's on your mind?")).toBeVisible();

  // A local Send still lands immediately (local-first) even with sync off.
  const body = uniqueEntryBody("opt-in-sync-local");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  // Longer than one poll interval (SYNC_TICK_MS), so a loop that ignored
  // the empty Server URL would have already made a request. Proving an
  // absence, so there's nothing to poll for instead.
  await page.waitForTimeout(SYNC_TICK_MS + 1_000);

  expect(syncRequests).toBe(0);
});

test("saving a Server URL starts sync on the next tick, with no reload", async ({ page }) => {
  // The continuous sync loop starts from EntryStoreLayout once the Entry
  // store opens (ADR 0009) — Settings is a sibling route, not wrapped by
  // it, so a Device that has never visited "/" has no loop running yet to
  // pick up the URL this test is about to save. Visiting "/" first is what
  // an actual first-run Device does.
  await page.goto("/composer");
  await openDestination(page, "Settings");
  await expect(page).toHaveURL("/settings");

  let syncRequests = 0;
  page.on(
    "request",
    countSyncRequests((count) => (syncRequests = count)),
  );

  await page.getByLabel(/server url/i).fill(SERVER_A_URL);
  await page.getByRole("button", { name: "Save server URL" }).click();
  await expect(page.getByTestId("server-status")).toContainText(/reachable/i);

  await expect.poll(() => syncRequests, { timeout: 10_000 }).toBeGreaterThan(0);
});

test("clearing a Server URL stops sync", async ({ page }) => {
  await page.goto("/composer");
  await openDestination(page, "Settings");
  await expect(page).toHaveURL("/settings");
  await page.getByLabel(/server url/i).fill(SERVER_A_URL);
  await page.getByRole("button", { name: "Save server URL" }).click();
  await expect(page.getByTestId("server-status")).toContainText(/reachable/i);

  let syncRequests = 0;
  page.on(
    "request",
    countSyncRequests((count) => (syncRequests = count)),
  );
  await expect.poll(() => syncRequests, { timeout: 10_000 }).toBeGreaterThan(0);

  await page.getByLabel(/server url/i).fill("");
  await page.getByRole("button", { name: "Save server URL" }).click();
  await expect(page.getByTestId("server-status")).toContainText(/no server/i);

  const requestsAtClear = syncRequests;
  // Another absence to prove — longer than one poll interval, nothing to
  // poll for instead.
  await page.waitForTimeout(SYNC_TICK_MS + 1_000);
  expect(syncRequests).toBe(requestsAtClear);
});
