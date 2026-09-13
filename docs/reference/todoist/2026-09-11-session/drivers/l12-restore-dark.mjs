const task = await taskSpace(31);
const page = task.page("p1");

// We should currently be on settings/theme with Moonstone selected/saved.
await page.click("loc=css:button[aria-label=\"Dark\"]", { label: "select Dark theme swatch" });
await page.waitForTimeout(500);

const hasUpdate = await page.evaluate(() => !!([...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Update")));
console.log("hasUpdateButton:", hasUpdate);

await page.click("loc=role:button[name='Update']", { label: "click Update to save Dark theme" });
await page.waitForTimeout(1000);
console.log("clicked update for Dark");
