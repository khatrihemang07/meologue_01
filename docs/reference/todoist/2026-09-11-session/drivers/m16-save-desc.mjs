const task = await taskSpace(32);
const page = task.page("p1");

await page.click("loc=role:textbox[name='Description']");
await page.keyboard.type("Use the new shampoo and condition well.");
await page.click("loc=role:button[name='Save']");
await page.waitForTimeout(500);
await page.click("loc=role:button[name='Close']");
await page.waitForTimeout(500);
console.log(await page.snapshot());
