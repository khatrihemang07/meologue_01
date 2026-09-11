const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  const rowBoxes = Array.from(document.querySelectorAll('[data-task-row-box]'));
  return rowBoxes.map((el) => {
    const r = el.getBoundingClientRect();
    const titleBtn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.trim().length > 0 && !b.getAttribute('aria-label'));
    return {
      height: Math.round(r.height),
      title: titleBtn ? titleBtn.textContent.trim() : null,
    };
  });
});

console.log(JSON.stringify(result, null, 2));

// Now add a task with a very long title to force wrap
await page.click("loc=role:textbox[name='Add a Task']");
await page.keyboard.type("This is an extremely long task title that should wrap across multiple lines in the row when the column is not wide enough to fit it on one single line of text");
await page.keyboard.press("Enter");
await page.waitForTimeout(700);

const result2 = await page.evaluate(() => {
  const rowBoxes = Array.from(document.querySelectorAll('[data-task-row-box]'));
  return rowBoxes.map((el) => {
    const r = el.getBoundingClientRect();
    const titleBtn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.trim().length > 0 && !b.getAttribute('aria-label'));
    return {
      height: Math.round(r.height),
      title: titleBtn ? titleBtn.textContent.trim().slice(0,40) : null,
    };
  });
});
console.log("AFTER LONG TITLE:", JSON.stringify(result2, null, 2));
