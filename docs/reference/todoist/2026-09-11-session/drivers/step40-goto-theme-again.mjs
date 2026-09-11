const task = await taskSpace(30);
const page = task.page("p1");

await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
});
await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const state = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  return {
    matchesLight: window.matchMedia("(prefers-color-scheme: light)").matches,
    sync: boxes[0]?.checked,
    auto: boxes[1]?.checked,
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log(JSON.stringify(state));
