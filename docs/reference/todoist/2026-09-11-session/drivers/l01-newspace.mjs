const task = await taskSpace("Todoist light theme capture (THEME-01)");
const page = task.page("p1");
await page.goto("https://app.todoist.com/app/today", { waitUntil: "load" });
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const html = document.documentElement;
  const body = document.body;
  const bodyStyle = getComputedStyle(body);
  const htmlStyle = getComputedStyle(html);
  return {
    htmlClass: html.className,
    url: location.href,
    bodyBg: bodyStyle.backgroundColor,
    bodyColor: bodyStyle.color,
    htmlBg: htmlStyle.backgroundColor,
    prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  };
});

console.log("spaceId:", task.spaceId);
console.log(JSON.stringify(info, null, 2));

const shot = await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/l01-initial.png" });
console.log("screenshot:", shot);
