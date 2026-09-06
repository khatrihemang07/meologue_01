import { expect, test } from "./fixtures";
import { openDestination, sendEntry, uniqueEntryBody } from "./helpers";

// Issue #197: Restore is the destructive counterpart to Backup (#195,
// export.spec.ts's own sibling artifact) — "this Device becomes the
// Backup." This spec drives the real download for Backup (mirroring
// export.spec.ts exactly) and Playwright's `filechooser` event for
// Restore's own file-picking seam (@/platform/load-file), which is the
// click-triggered equivalent of `Locator.setInputFiles` for a
// programmatically created, transient `<input type="file">` — the input
// load-file.web.ts creates is appended to the DOM and removed again within
// a single synchronous call, so a `filechooser` listener registered before
// the click (the same `Promise.all` shape export.spec.ts's own download
// capture already uses) is what actually catches it, rather than a
// selector-based `setInputFiles` racing an element that may already be
// gone.

test("Backup, then Restore from it, replaces this Device's contents and Search works immediately after", async ({
  page,
}) => {
  const keptBody = uniqueEntryBody("restore-kept");
  const lostBody = uniqueEntryBody("restore-lost");

  await page.goto("/composer");
  await sendEntry(page, keptBody);
  await expect(page.getByText(keptBody)).toBeVisible();

  await openDestination(page, "Settings");
  await expect(page).toHaveURL("/settings");

  const backupButton = page.getByRole("button", { name: "Back up this Device" });
  await expect(backupButton).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), backupButton.click()]);
  const backupPath = await download.path();
  expect(backupPath).not.toBeNull();

  // Created after the Backup above was taken — Restore replaces this
  // Device's contents with the Backup's (issue #197's own "this Device
  // becomes the Backup" framing), so this Entry should be gone once that
  // Backup is restored, not merged alongside it.
  await openDestination(page, "Composer");
  await sendEntry(page, lostBody);
  await expect(page.getByText(lostBody)).toBeVisible();

  await openDestination(page, "Settings");
  const restoreButton = page.getByRole("button", { name: "Restore from a Backup…" });
  await expect(restoreButton).toBeEnabled();
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    restoreButton.click(),
  ]);
  await fileChooser.setFiles(backupPath as string);

  await expect(page.getByText("Restore this Device from a Backup?")).toBeVisible();
  // Issue #204: the dialog promises a safety Backup before it acts. That
  // sentence is the only warning a reader gets that a second file is about
  // to be saved, so it is worth pinning here rather than trusting the unit
  // suite alone — data-section.test.tsx renders this dialog without ever
  // reaching the save seam it describes.
  await expect(page.getByText(/A safety Backup of what's currently on this Device/)).toBeVisible();
  await page.getByLabel("Type RESTORE to confirm").fill("RESTORE");

  // Issue #204: Restore saves a safety Backup of this Device before it
  // writes anything, so the click below raises a download of its own on
  // top of the reload. Registered before the click for the same reason the
  // `load` listener is — an event that has already fired cannot be waited
  // for afterwards.
  const safetyBackup = page.waitForEvent("download");

  // A successful Restore reloads the page (settings-page.tsx's own
  // handleConfirmRestore) — waiting for the real `load` event, registered
  // before the click, is what proves that reload actually happened rather
  // than the test simply racing ahead of it.
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Restore" }).click(),
  ]);

  // The safety Backup names itself as one. The prefix is the whole point
  // (backup-zip.ts's `backupFileName` and its `BackupKind`): it is what
  // tells the two apart at a glance in a Downloads folder, where a Backup
  // taken on purpose and one taken to guard a Restore sit side by side.
  expect((await safetyBackup).suggestedFilename()).toContain("meologue-safety-backup-");

  await openDestination(page, "Composer");
  await expect(page.getByText(keptBody)).toBeVisible();
  await expect(page.getByText(lostBody)).toHaveCount(0);

  // Search works immediately (issue #197: the FTS5 indexes are rebuilt
  // eagerly, before restoreFromBackup reports done) — a Restore that
  // finishes fast and then returns nothing for every Search would look
  // exactly like data loss.
  await page.getByRole("button", { name: "Search History" }).click();
  await page.getByRole("searchbox", { name: "Search History" }).fill(keptBody);
  await expect(page.getByText(keptBody)).toBeVisible();
});
