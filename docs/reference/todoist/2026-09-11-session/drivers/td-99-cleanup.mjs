// Todoist capture pass 2 — cleanup. Capture is complete; release the
// browser so it stops holding memory (the OS already OOM-killed a dev
// server in this session).
const task = await taskSpace(30);
const tabs = await task.tabs();
console.log("tabs before finish:");
for (const t of tabs) {
  console.log({ label: t.label ?? null, url: (t.url || "").slice(0, 80), openedBy: t.openedBy });
}
await task.finish({ keep: [] });
console.log("task space 30 finished, no pages kept");
