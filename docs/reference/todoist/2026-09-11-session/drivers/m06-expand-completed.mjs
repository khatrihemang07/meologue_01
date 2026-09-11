const task = await taskSpace(32);
const page = task.page("p1");
await page.click("text=Completed (1)");
await page.waitForTimeout(600);
console.log(await page.snapshot());
