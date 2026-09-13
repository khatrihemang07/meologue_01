// Todoist capture pass 2 — final cleanup. Light-theme investigation is
// concluded; release space 31 so the browser stops holding memory.
const task = await taskSpace(31);
const tabs = await task.tabs();
console.log("tabs before finish:");
for (const t of tabs) {
  console.log({ label: t.label ?? null, url: (t.url || "").slice(0, 80), openedBy: t.openedBy });
}
await task.finish({ keep: [] });
console.log("task space 31 finished, no pages kept");
