// Todoist capture pass 2 — STEP 6: diagnose why light theme never applied.
// Skeptical retry. First CLEARS any leftover CDP media emulation (a stuck
// override from the previous agent is a live hypothesis), then reads the
// Settings theme panel as ground truth rather than guessing names.
const task = await taskSpace(30);
const page = task.page("p1");

// 1. Clear any emulation override left behind by the previous run.
try {
  await page.cdp("Emulation.setEmulatedMedia", { features: [] });
  console.log("cleared Emulation.setEmulatedMedia");
} catch (e) {
  console.log("could not clear emulated media:", String(e).slice(0, 120));
}

await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(6000);

console.log("URL:", await page.url());

const state = await page.evaluate(() => {
  const root = document.documentElement;
  return {
    htmlClass: root.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    colorScheme: getComputedStyle(root).colorScheme,
    matchesDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    matchesLight: window.matchMedia("(prefers-color-scheme: light)").matches,
    // Every control on the theme settings page, so theme names come from
    // the app rather than from my assumptions about what they're called.
    controls: [...document.querySelectorAll('button,[role="radio"],[role="option"],input')]
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        name: (el.getAttribute("aria-label") || el.innerText || el.value || "")
          .trim()
          .replace(/\n+/g, " ")
          .slice(0, 50),
        checked: el.getAttribute("aria-checked") ?? el.checked ?? null,
        selected: el.getAttribute("aria-selected"),
        dataTheme: el.getAttribute("data-theme") || el.getAttribute("data-value"),
      }))
      .filter((c) => c.name),
    bodyText: document.body.innerText.slice(0, 700).replace(/\n+/g, " | "),
  };
});

console.log("html.class :", state.htmlClass);
console.log("bodyBg     :", state.bodyBg, "| colorScheme:", state.colorScheme);
console.log("prefers dark:", state.matchesDark, "| prefers light:", state.matchesLight);
console.log("bodyText   :", state.bodyText);
console.log("--- controls on the theme settings page ---");
for (const c of state.controls) {
  console.log(
    `  <${c.tag}> role=${c.role} type=${c.type} checked=${c.checked} sel=${c.selected} theme=${c.dataTheme} :: ${JSON.stringify(c.name)}`,
  );
}

await page.screenshot({
  path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/td-theme-settings.png",
});
console.log("wrote td-theme-settings.png");
