const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

await page.click('button[aria-label="Todoist"]', { label: "select Todoist theme" });
await page.waitForTimeout(800);

console.log(await page.snapshot({ scope: "viewport" }));
