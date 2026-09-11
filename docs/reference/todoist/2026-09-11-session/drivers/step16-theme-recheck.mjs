const task = await taskSpace(30);
const page = task.page("p1");

await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const toggles = [...document.querySelectorAll('[role="switch"], input[type="checkbox"], button[aria-checked]')].map((el) => ({
    label: el.getAttribute("aria-label") || el.closest("label")?.innerText || el.parentElement?.innerText?.slice(0, 60),
    checked: el.getAttribute("aria-checked") ?? el.checked,
  }));
  const selectedTheme = [...document.querySelectorAll('[aria-checked="true"], [aria-pressed="true"]')].map((el) => el.getAttribute("aria-label"));
  return { toggles, selectedTheme, htmlClass: document.documentElement.className };
});
console.log(JSON.stringify(info, null, 2));
console.log(await page.snapshot());
