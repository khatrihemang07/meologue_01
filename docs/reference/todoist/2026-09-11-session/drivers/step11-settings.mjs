const task = await taskSpace(30);
const page = task.page("p1");

// Make sure quick add is closed and we're on inbox first.
await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const preClass = await page.evaluate(() => document.documentElement.className);
console.log("PRE theme class:", preClass);

await page.click('button[aria-label="Settings"]', { label: "open Settings menu" });
await page.waitForTimeout(1000);
console.log(await page.snapshot());
