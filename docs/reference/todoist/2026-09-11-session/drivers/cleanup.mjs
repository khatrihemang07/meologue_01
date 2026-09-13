const task = await taskSpace(29);
const tabs = await task.tabs();
console.log("tabs before finish:");
for (const t of tabs) {
  console.log({ label: t.label ?? null, url: t.url, openedBy: t.openedBy });
}
await task.finish({ keep: [] });
console.log("task space 29 finished, no pages kept");
