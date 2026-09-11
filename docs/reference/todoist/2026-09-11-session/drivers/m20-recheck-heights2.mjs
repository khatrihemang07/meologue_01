const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  const rowBoxes = Array.from(document.querySelectorAll('[data-task-row-box]'));
  return rowBoxes.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      y: Math.round(r.y),
      height: Math.round(r.height),
      text: el.textContent.trim().slice(0, 60),
    };
  });
});

console.log(JSON.stringify(result, null, 2));
