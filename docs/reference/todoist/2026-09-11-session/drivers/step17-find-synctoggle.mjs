const task = await taskSpace(30);
const page = task.page("p1");

const info = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[role="switch"]')];
  return els.map((el, i) => ({
    i,
    label: el.getAttribute("aria-label"),
    checked: el.getAttribute("aria-checked"),
    outerHTMLSnippet: el.outerHTML.slice(0, 150),
    nearbyText: el.closest("div")?.parentElement?.innerText?.slice(0, 80),
  }));
});
console.log(JSON.stringify(info, null, 2));
