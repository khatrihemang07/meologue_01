const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";
const out = {};

// Reopen scheduler
await page.click('loc=role:button[name="Set date"]', { label: "reopen scheduler for Time" }).catch(async (e) => {
  out.schedulerReopenError = e.message;
});
await page.waitForTimeout(1000);

out.preClickSnapshotHint = await page.evaluate(() => ({
  schedulerOpen: !!document.querySelector('[data-testid="scheduler-view"]'),
}));

await page.click('loc=role:button[name="Time"]', { label: "click Time button" }).catch(async (e) => {
  out.timeClickError = e.message;
});
await page.waitForTimeout(1000);

console.log(await page.snapshot());
