const task = await taskSpace(30);
const page = task.page("p1");

await page.click('button[aria-label="Todoist"]', { label: "select Todoist (light) theme" });
await page.waitForTimeout(1500);

const themeClass = await page.evaluate(() => document.documentElement.className);
console.log("theme class after clicking Todoist:", themeClass);

// Close settings dialog
await page.click('button[aria-label="Close settings"]', { label: "close settings dialog" }).catch(async (e) => {
  console.log("close click failed:", e.message);
});
await page.waitForTimeout(1000);

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2500);
const finalClass = await page.evaluate(() => document.documentElement.className);
console.log("theme class on inbox:", finalClass);
await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/td-inbox-light.png" });
