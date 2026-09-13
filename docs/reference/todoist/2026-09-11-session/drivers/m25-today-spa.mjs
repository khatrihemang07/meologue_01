const task = await taskSpace(32);
const page = task.page("p1");
await page.click("loc=role:link[name='Today 1']").catch(async () => {
  await page.click("loc=href:/todo/today");
});
await page.waitForTimeout(800);
const locked = await page.evaluate(() => document.body.innerText.includes("already open in another window"));
console.log("locked:", locked);
console.log(await page.snapshot());
