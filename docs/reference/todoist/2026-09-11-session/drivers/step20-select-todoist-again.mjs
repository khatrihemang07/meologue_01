const task = await taskSpace(30);
const page = task.page("p1");

await page.click('button[aria-label="Todoist"]', { label: "select Todoist theme again after disabling sync" });
await page.waitForTimeout(1200);

const themeClass = await page.evaluate(() => document.documentElement.className);
console.log("theme class:", themeClass);

await page.click('button[aria-label="Close settings"]', { label: "close settings" }).catch(() => {});
await page.waitForTimeout(1000);

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2500);

const bg = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log(JSON.stringify(bg));
await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/td-inbox-light2.png" });
