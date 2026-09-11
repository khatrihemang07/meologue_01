const task = await taskSpace(31);
const page = task.page("p1");

const pre = await page.evaluate(() => {
  const radios = [...document.querySelectorAll('[role="radio"], button[aria-checked]')].map(el => ({
    label: el.getAttribute("aria-label") || el.textContent?.trim(),
    checked: el.getAttribute("aria-checked"),
  }));
  return {
    radios,
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log("PRE-UPDATE:", JSON.stringify(pre, null, 2));

await page.click("loc=role:button[name='Update']", { label: "click Update to save Todoist theme" });
await page.waitForTimeout(1500);

const postClick = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log("POST-CLICK (pre-reload):", JSON.stringify(postClick, null, 2));
