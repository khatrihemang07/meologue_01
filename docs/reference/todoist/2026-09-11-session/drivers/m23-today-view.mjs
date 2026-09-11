const task = await taskSpace(32);
const page = task.page("p1");
await page.goto("http://127.0.0.1:5188/todo/today");
await page.waitForTimeout(800);
console.log(await page.snapshot());
await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/meologue-today.png" });
