const task = await taskSpace(32);
await task.finish({ keep: [] });
console.log("finished");
