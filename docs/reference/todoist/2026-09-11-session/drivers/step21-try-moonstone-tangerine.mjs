const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const results = {};
for (const name of ["Moonstone", "Tangerine"]) {
  await page.click(`button[aria-label="${name}"]`, { label: `select ${name} theme` });
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => ({
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
  }));
  results[name] = info;
  await page.screenshot({ path: `${OUT}/td-theme-${name.toLowerCase()}.png` });
}

await fs.writeFile(`${OUT}/td-theme-probe.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
