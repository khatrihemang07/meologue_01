const task = await taskSpace(32);
const page = task.page("p1");
const bodyContainsLock = await page.evaluate(() => document.body.innerText.includes("already open in another window"));
console.log("lockMessage:", bodyContainsLock);
const info = await page.evaluate(() => {
  const html = document.documentElement;
  const body = document.body;
  return {
    htmlClass: html.className,
    htmlDataTheme: html.getAttribute("data-theme"),
    bodyClass: body.className,
    bodyBg: getComputedStyle(body).backgroundColor,
    htmlBg: getComputedStyle(html).backgroundColor,
  };
});
console.log(JSON.stringify(info, null, 2));
