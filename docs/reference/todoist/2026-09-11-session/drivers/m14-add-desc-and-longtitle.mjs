const task = await taskSpace(32);
const page = task.page("p1");

// Open hair wash detail to add a description
await page.click("loc=role:button[name='hair wash']");
await page.waitForTimeout(700);
console.log("--- detail snapshot ---");
console.log(await page.snapshot());
