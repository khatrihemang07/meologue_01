const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const info = await page.evaluate(() => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (/theme|dark|light|color|scheme|mode/i.test(k)) {
      ls[k] = localStorage.getItem(k);
    }
  }
  // Also check for any global window flags
  const globals = Object.keys(window).filter((k) => /theme|dark|color.?scheme/i.test(k));
  return { localStorageMatches: ls, globalKeys: globals, htmlStyleAttr: document.documentElement.getAttribute("style") };
});
console.log(JSON.stringify(info, null, 2));
await fs.writeFile(`${OUT}/td-storage-inspect.json`, JSON.stringify(info, null, 2));
