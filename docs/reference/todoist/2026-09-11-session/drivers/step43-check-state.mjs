const task = await taskSpace(30);
const page = task.page("p1");
const info = await page.evaluate(() => ({
  bodyBg: getComputedStyle(document.body).backgroundColor,
  htmlClass: document.documentElement.className,
}));
console.log(JSON.stringify(info));
console.log(await page.snapshot());
