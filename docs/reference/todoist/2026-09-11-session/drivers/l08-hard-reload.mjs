const task = await taskSpace(31);
const page = task.page("p1");

// Hard reload via CDP to bypass cache, mirroring a true hard reload
await page.cdp("Page.reload", { ignoreCache: true });
await page.waitForLoadState("load");
await page.waitForTimeout(1500);

const state = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  url: location.href,
  prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
}));
console.log("AFTER HARD RELOAD:", JSON.stringify(state, null, 2));

const path = await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/l08-after-reload.png" });
console.log("screenshot:", path);
