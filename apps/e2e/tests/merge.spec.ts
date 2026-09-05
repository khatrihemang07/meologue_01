import { expect, test } from "./fixtures";
import { openDestination, sendEntry, uniqueEntryBody } from "./helpers";

// Issue #199: Merge is the additive counterpart to Restore (restore.spec.ts's
// own sibling) — a row only the Backup has arrives, a row only this Device
// has stays exactly as it is. Two plain `browser.newContext()` pages, not
// `openTwoDevices` (sync.spec.ts's own helper): that helper seeds a Server
// URL for a Sync scenario, and Merge needs the opposite — two Devices that
// have never synced with each other or with a Server at all (ADR 0011's
// default), so this is the realistic shape of "a Device with mostly-shared
// or entirely separate history."
test("a Backup from one Device merges into another, adding what it's missing and leaving what it already has", async ({
  browser,
}) => {
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const pageA = await deviceA.newPage();
  const pageB = await deviceB.newPage();
  await pageA.goto("/composer");
  await pageB.goto("/composer");

  const onlyOnA = uniqueEntryBody("merge-only-on-a");
  const onlyOnB = uniqueEntryBody("merge-only-on-b");

  await sendEntry(pageA, onlyOnA);
  await expect(pageA.getByText(onlyOnA)).toBeVisible();

  await sendEntry(pageB, onlyOnB);
  await expect(pageB.getByText(onlyOnB)).toBeVisible();
  // Never seen device A's Entry — proves the row B is about to gain
  // afterward really did come from the Backup, not from anywhere else.
  await expect(pageB.getByText(onlyOnA)).toHaveCount(0);

  await openDestination(pageA, "Settings");
  const backupButton = pageA.getByRole("button", { name: "Back up this Device" });
  await expect(backupButton).toBeEnabled();
  const [download] = await Promise.all([pageA.waitForEvent("download"), backupButton.click()]);
  const backupPath = await download.path();
  expect(backupPath).not.toBeNull();

  await openDestination(pageB, "Settings");
  const mergeButton = pageB.getByRole("button", { name: "Merge a Backup…" });
  await expect(mergeButton).toBeEnabled();
  // Merge's own confirm() is a native dialog (data-section.tsx's own
  // handleMerge doc comment on why a plain confirm is right, rather than
  // DestructiveConfirmDialog's typed word) — Playwright dismisses a native
  // dialog by default, so accepting it needs an explicit listener,
  // registered before the click that raises it.
  pageB.once("dialog", (dialog) => dialog.accept());
  const [fileChooser] = await Promise.all([pageB.waitForEvent("filechooser"), mergeButton.click()]);
  await fileChooser.setFiles(backupPath as string);

  // A successful Merge reloads the page (data-section.tsx's own handleMerge
  // doc comment, mirroring Restore's identical reasoning) — waiting for the
  // real `load` event is what proves that actually happened.
  await pageB.waitForEvent("load");

  await openDestination(pageB, "Composer");
  await expect(pageB.getByText(onlyOnA)).toBeVisible();
  // Merge adds and updates — it never replaces. B's own Entry must still be
  // there, unlike a Restore from A's Backup, which would have erased it.
  await expect(pageB.getByText(onlyOnB)).toBeVisible();

  // A never gained B's Entry — Merge only ran on B, one-directionally.
  await expect(pageA.getByText(onlyOnB)).toHaveCount(0);

  await deviceA.close();
  await deviceB.close();
});
