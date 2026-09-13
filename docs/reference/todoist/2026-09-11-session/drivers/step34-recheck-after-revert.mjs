const task = await taskSpace(30);
const page = task.page("p1");

await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const radios = [...document.querySelectorAll('button[role="radio"]')].map((b) => ({
    label: b.getAttribute("aria-label"),
    checked: b.getAttribute("aria-checked"),
  }));
  return {
    sync: boxes[0]?.checked,
    auto: boxes[1]?.checked,
    radios,
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log(JSON.stringify(info, null, 2));
