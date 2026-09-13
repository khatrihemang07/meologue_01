const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const checkedBefore = await page.evaluate(() => document.querySelector('button[aria-label="Todoist"]')?.getAttribute("aria-checked"));
console.log("Todoist aria-checked before Update:", checkedBefore);

await page.click('text="Update"', { label: "click Update to persist theme selection" });
await page.waitForTimeout(2000);

const info = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  dialogOpen: !!document.querySelector('[role="dialog"][aria-label="Settings"]'),
}));
console.log("after Update:", JSON.stringify(info));

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2500);

const info2 = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log("after reload on inbox:", JSON.stringify(info2));
await page.screenshot({ path: `${OUT}/td-inbox-light-final.png` });
await fs.writeFile(`${OUT}/td-theme-update-result.json`, JSON.stringify({ checkedBefore, info, info2 }, null, 2));
