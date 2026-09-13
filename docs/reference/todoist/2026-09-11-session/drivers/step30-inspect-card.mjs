const task = await taskSpace(30);
const page = task.page("p1");

await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const html = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Todoist"]');
  if (!btn) return null;
  // climb to the card container
  let card = btn;
  for (let i = 0; i < 3 && card.parentElement; i++) card = card.parentElement;
  return card.outerHTML.slice(0, 3000);
});
console.log(html);
