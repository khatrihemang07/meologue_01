const task = await taskSpace(30);
const page = task.page("p1");
await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2000);
await page.click("button:has-text('Add task') >> nth=0", { label: "open Quick Add" });
await page.waitForTimeout(1500);
console.log(await page.snapshot());
