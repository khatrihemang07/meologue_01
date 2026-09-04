import { SERVER_B_URL } from "../servers";
import { expect, test } from "./fixtures";
import { closeDevices, openTwoDevices, SYNC_TICK_MS, sendEntry, uniqueEntryBody } from "./helpers";

// ADR 0011: a Device is not bound to a particular Server — the Server URL
// setting is the only thing that decides where its Entries go. Two fully
// independent Servers (separate Postgres containers, separate ports, no
// shared state — see docker-compose.yml's postgres-e2e-b and
// scripts/e2e-server-b.sh) prove that: an Entry captured on the Device
// pointed at one must never appear on the Device pointed at the other, even
// though both Devices load the same app from the same origin.

test("Devices pointed at different Servers stay fully isolated", async ({ browser }) => {
  const devices = await openTwoDevices(browser, { serverUrlB: SERVER_B_URL });
  const { pageA, pageB } = devices;

  const bodyOnA = uniqueEntryBody("server-a-only");
  await sendEntry(pageA, bodyOnA);
  await expect(pageA.getByText(bodyOnA)).toBeVisible();

  const bodyOnB = uniqueEntryBody("server-b-only");
  await sendEntry(pageB, bodyOnB);
  await expect(pageB.getByText(bodyOnB)).toBeVisible();

  // Long enough for several poll intervals on each side — if the Server
  // URL were being ignored (e.g. both syncing through the same Server
  // regardless of setting), this is well past when the cross-over would
  // show. Proving an absence, so there's nothing to poll for instead.
  await pageA.waitForTimeout(SYNC_TICK_MS + 3_000);

  await expect(pageA.getByText(bodyOnB)).toHaveCount(0);
  await expect(pageB.getByText(bodyOnA)).toHaveCount(0);

  await closeDevices(devices);
});

test("a Device pointed at the second Server syncs normally through it", async ({ browser }) => {
  const devices = await openTwoDevices(browser, {
    serverUrlA: SERVER_B_URL,
    serverUrlB: SERVER_B_URL,
  });
  const { pageA, pageB } = devices;

  const body = uniqueEntryBody("both-on-server-b");
  await sendEntry(pageA, body);

  await expect(pageA.getByText(body)).toBeVisible();
  await expect(pageB.getByText(body)).toBeVisible({ timeout: 20_000 });

  await closeDevices(devices);
});
