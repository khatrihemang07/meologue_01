const task = await taskSpace(32);
const page = task.page("p1");

await page.click("loc=role:textbox[name='Add a Task']");
const longTitle = "Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu alpha bravo charlie delta echo foxtrot golf hotel india juliet";
await page.keyboard.type(longTitle);
await page.keyboard.press("Enter");
await page.waitForTimeout(700);

const result = await page.evaluate(() => {
  const rowBoxes = Array.from(document.querySelectorAll('[data-task-row-box]'));
  return rowBoxes.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      y: Math.round(r.y),
      height: Math.round(r.height),
      text: el.textContent.trim().slice(0, 40),
    };
  });
});

console.log(JSON.stringify(result, null, 2));
