const task = await taskSpace(32);
const page = task.page("p1");
await page.click("loc=role:link[name='Inbox 4']");
await page.waitForTimeout(700);
await page.click("loc=role:button[name='hair wash']");
await page.waitForTimeout(700);
await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/meologue-task-detail-final.png" });
console.log("done");
