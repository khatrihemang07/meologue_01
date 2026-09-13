const task = await taskSpace(32);
const page = task.page("p1");
await page.click("loc=css:input[aria-label=\"naukri photo update\"]");
await page.waitForTimeout(1000);
console.log(await page.snapshot());
