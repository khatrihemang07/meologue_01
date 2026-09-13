const task = await taskSpace(31);
const pages = await task.pages();
console.log("PAGES:", JSON.stringify(pages.map(p => p.label)));
const page = task.page("p1");
console.log("URL:", await page.url());
console.log("TITLE:", await page.title());

const state = await page.evaluate(() => {
  const html = document.documentElement;
  return {
    htmlClass: html.className,
    prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    darkReaderStyleCount: document.querySelectorAll("style.darkreader").length,
    darkReaderClassCount: document.querySelectorAll('[class*="darkreader"]').length,
    darkReaderInlineBgCount: document.querySelectorAll('[data-darkreader-inline-bgcolor]').length,
    darkReaderProxy: html.getAttribute("data-darkreader-proxy-injected"),
  };
});
console.log("STATE:", JSON.stringify(state, null, 2));
