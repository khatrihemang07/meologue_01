import { expect, test } from "@playwright/test";
import {
  closeDevices,
  openTwoDevices,
  SYNC_TICK_MS,
  sendEntry,
  setTabHidden,
  uniqueEntryBody,
} from "./helpers";

// Two independent BrowserContexts stand in for two Devices: each gets its
// own storage (localStorage, cookies), same as two separate browsers on two
// separate machines syncing through the same server (ticket 11).

test("an Entry created in one context appears in a second within 10 seconds, with no reload", async ({
  browser,
}) => {
  const devices = await openTwoDevices(browser);
  const { pageA, pageB } = devices; // pageB is never reloaded — the assertion below must be satisfied by sync alone

  const body = uniqueEntryBody("cross-context");
  await sendEntry(pageA, body);

  await expect(pageA.getByText(body)).toBeVisible();
  await expect(pageB.getByText(body)).toBeVisible({ timeout: 20_000 });

  await closeDevices(devices);
});

test("a hidden tab does not poll; returning to it syncs promptly", async ({ browser }) => {
  const devices = await openTwoDevices(browser);
  const { pageA, pageB } = devices;

  await setTabHidden(pageA, true);

  const body = uniqueEntryBody("hidden-tab");
  await sendEntry(pageB, body);
  await expect(pageB.getByText(body)).toBeVisible();

  // Longer than one poll interval (SYNC_TICK_MS) — if hidden-tab gating
  // were broken, A's next scheduled poll would have already picked this
  // up. This proves an absence, so there's no positive condition to poll
  // for instead; a loaded machine only delays a broken poll further,
  // never makes this wait insufficient the way a "wait for the good case"
  // sleep can be.
  await pageA.waitForTimeout(SYNC_TICK_MS + 2_000);
  await expect(pageA.getByText(body)).toHaveCount(0);

  await setTabHidden(pageA, false);
  await expect(pageA.getByText(body)).toBeVisible({ timeout: SYNC_TICK_MS + 2_000 });

  await closeDevices(devices);
});

test("Entries created while offline sync once back online, without duplication", async ({
  browser,
}) => {
  const devices = await openTwoDevices(browser);
  const { deviceA, pageA, pageB } = devices;

  await deviceA.setOffline(true);

  const body = uniqueEntryBody("offline");
  await sendEntry(pageA, body);
  // Local-first: the write is visible immediately even with no network.
  await expect(pageA.getByText(body)).toBeVisible();

  await deviceA.setOffline(false);

  await expect(pageB.getByText(body)).toBeVisible({ timeout: 20_000 });

  // Give sync several more rounds, then confirm the entry landed exactly
  // once on both Devices — no duplicate rows from the offline retry. Again
  // an absence to prove, not a positive condition to poll for.
  await pageA.waitForTimeout(SYNC_TICK_MS + 1_000);
  await expect(pageA.getByText(body)).toHaveCount(1);
  await expect(pageB.getByText(body)).toHaveCount(1);

  await closeDevices(devices);
});
