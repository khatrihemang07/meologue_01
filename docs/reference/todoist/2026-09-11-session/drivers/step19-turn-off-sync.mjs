const task = await taskSpace(30);
const page = task.page("p1");

const result = await page.evaluate(() => {
  const findByText = (txt) => [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent.trim() === txt);
  const syncLabel = findByText("Sync theme");
  let row = syncLabel;
  for (let i = 0; i < 4 && row; i++) row = row.parentElement;
  const checkbox = row ? row.querySelector('input[type="checkbox"]') : null;
  if (!checkbox) return { found: false };
  checkbox.click();
  return { found: true, checkedAfter: checkbox.checked };
});
console.log(JSON.stringify(result));
await page.waitForTimeout(1000);

const themeClass = await page.evaluate(() => document.documentElement.className);
console.log("theme class after turning off Sync theme:", themeClass);
