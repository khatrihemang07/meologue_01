const task = await taskSpace(30);
const page = task.page("p1");

await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2000);
console.log(await page.snapshot());
