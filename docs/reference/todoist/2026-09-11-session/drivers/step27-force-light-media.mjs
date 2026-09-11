const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// Check what prefers-color-scheme currently resolves to, then try forcing
// light via CDP emulation to see if the "Todoist" theme's true light palette
// appears (read-only investigation, no persistent browser setting changed).
const before = await page.evaluate(() => ({
  matchesDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  matchesLight: window.matchMedia("(prefers-color-scheme: light)").matches,
  colorScheme: getComputedStyle(document.documentElement).colorScheme,
  bodyBg: getComputedStyle(document.body).backgroundColor,
}));
console.log("BEFORE emulation:", JSON.stringify(before));

await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
});
await page.waitForTimeout(1000);

const after = await page.evaluate(() => ({
  matchesDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  matchesLight: window.matchMedia("(prefers-color-scheme: light)").matches,
  colorScheme: getComputedStyle(document.documentElement).colorScheme,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  htmlClass: document.documentElement.className,
}));
console.log("AFTER forcing light media:", JSON.stringify(after));
await page.screenshot({ path: `${OUT}/td-theme-forced-light-media.png` });

await fs.writeFile(`${OUT}/td-media-emulation-check.json`, JSON.stringify({ before, after }, null, 2));
