const task = await taskSpace(30);
const page = task.page("p1");

// Reopen scheduler (quick-add is still open with "tod" typed and date set)
await page.click('loc=role:button[name="Set date"]', { label: "reopen scheduler popover" }).catch(async (e) => {
  console.log("Set date click failed:", e.message);
});
await page.waitForTimeout(1000);

await page.click('button[data-testid="recurrence-menu-button"]', { label: "click Repeat button" });
await page.waitForTimeout(1000);

console.log(await page.snapshot());
