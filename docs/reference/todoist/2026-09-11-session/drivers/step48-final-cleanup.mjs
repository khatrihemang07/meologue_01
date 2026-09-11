const task = await taskSpace(30);
const page = task.page("p1");

await page.click('button[aria-label="Close settings"]', { label: "close settings dialog" }).catch(() => {});
await page.waitForTimeout(600);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const final = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  taskTitles: [...document.querySelectorAll("li[data-item-id] div.task_content")].map((n) => n.innerText.trim()),
  dialogs: document.querySelectorAll('[role="dialog"]').length,
}));
console.log(JSON.stringify(final, null, 2));
