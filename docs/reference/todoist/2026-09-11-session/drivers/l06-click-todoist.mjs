const task = await taskSpace(31);
const page = task.page("p1");
await page.click("loc=css:button[aria-label=\"Todoist\"]", { label: "select Todoist theme swatch" });
await page.waitForTimeout(500);
console.log(await page.snapshot());
