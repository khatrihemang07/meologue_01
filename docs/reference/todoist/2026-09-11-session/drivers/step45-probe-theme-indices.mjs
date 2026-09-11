const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const results = {};
for (let i = 0; i <= 13; i++) {
  await page.goto(`https://app.todoist.com/app/inbox?theme=${i}`);
  await page.waitForLoadState();
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
  }));
  results[i] = info;
  console.log(i, JSON.stringify(info));
}
await fs.writeFile(`${OUT}/td-theme-index-probe.json`, JSON.stringify(results, null, 2));
