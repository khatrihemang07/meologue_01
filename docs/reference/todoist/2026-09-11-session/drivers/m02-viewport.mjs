const task = await taskSpace(32);
const page = task.page("p1");
console.log("before:", JSON.stringify(await page.info()));
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1470,
  height: 836,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.waitForTimeout(300);
console.log("after:", JSON.stringify(await page.info()));
