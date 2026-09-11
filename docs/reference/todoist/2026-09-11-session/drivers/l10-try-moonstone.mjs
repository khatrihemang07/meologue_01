const task = await taskSpace(31);
const page = task.page("p1");

await page.click("loc=css:button[aria-label=\"Moonstone\"]", { label: "select Moonstone theme swatch" });
await page.waitForTimeout(500);

const preUpdateSnap = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Update");
  return { hasUpdateButton: !!btn };
});
console.log("PRE:", JSON.stringify(preUpdateSnap));

await page.click("loc=role:button[name='Update']", { label: "click Update to save Moonstone theme" });
await page.waitForTimeout(1000);

console.log("clicked update for Moonstone");
