const task = await taskSpace(30);
const page = task.page("p1");

await page.click('loc=href:/app/settings/account', { label: "open Settings page" });
await page.waitForLoadState();
await page.waitForTimeout(2000);
console.log(await page.snapshot());
