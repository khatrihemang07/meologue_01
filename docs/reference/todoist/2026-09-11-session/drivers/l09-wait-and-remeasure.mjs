const task = await taskSpace(31);
const page = task.page("p1");

await page.waitForSelector("loc=css:h1, loc=css:[role=heading]", { timeout: 15000 }).catch(e => console.log("waitForSelector heading failed:", e.message));
await page.waitForTimeout(2000);

const state = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  readyState: document.readyState,
  url: location.href,
}));
console.log("SETTLED STATE:", JSON.stringify(state, null, 2));

const path = await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/l09-settled.png" });
console.log("screenshot:", path);
