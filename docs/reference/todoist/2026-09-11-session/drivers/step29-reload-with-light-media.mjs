const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// Re-assert the light media emulation (in case it didn't persist across the
// earlier navigation to /settings/general), then reload so the app's JS
// re-evaluates system color scheme from scratch.
await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
});
await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(3000);

const info = await page.evaluate(() => ({
  matchesDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  matchesLight: window.matchMedia("(prefers-color-scheme: light)").matches,
  htmlClass: document.documentElement.className,
  colorScheme: getComputedStyle(document.documentElement).colorScheme,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: `${OUT}/td-after-reload-light-media.png` });
await fs.writeFile(`${OUT}/td-after-reload-light-media.json`, JSON.stringify(info, null, 2));
