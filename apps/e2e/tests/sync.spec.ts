import { expect, test } from "@playwright/test";
import { closeDevices, openTwoDevices, sendEntry, setTabHidden, uniqueEntryBody } from "./helpers";

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
  await expect(pageB.getByText(body)).toBeVisible({ timeout: 10_000 });

  await closeDevices(devices);
});

test("a hidden tab does not poll; returning to it syncs promptly", async ({ browser }) => {
  const devices = await openTwoDevices(browser);
  const { pageA, pageB } = devices;

  await setTabHidden(pageA, true);

  const body = uniqueEntryBody("hidden-tab");
  await sendEntry(pageB, body);
  await expect(pageB.getByText(body)).toBeVisible();

  // Longer than one poll interval — if hidden-tab gating were broken, A's
  // next scheduled poll would have already picked this up.
  await pageA.waitForTimeout(7_000);
  await expect(pageA.getByText(body)).toHaveCount(0);

  await setTabHidden(pageA, false);
  await expect(pageA.getByText(body)).toBeVisible({ timeout: 5_000 });

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

  await expect(pageB.getByText(body)).toBeVisible({ timeout: 10_000 });

  // Give sync several more rounds, then confirm the entry landed exactly
  // once on both Devices — no duplicate rows from the offline retry.
  await pageA.waitForTimeout(6_000);
  await expect(pageA.getByText(body)).toHaveCount(1);
  await expect(pageB.getByText(body)).toHaveCount(1);

  await closeDevices(devices);
});
