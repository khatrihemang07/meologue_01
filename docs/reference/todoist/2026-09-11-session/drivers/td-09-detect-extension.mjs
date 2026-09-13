// Todoist capture pass 2 — STEP 9: is an EXTENSION force-darkening the page?
// CDP's setAutoDarkModeOverride(false) did not stop the darkening, so
// Chromium's own inverter is ruled out. rgb(24,26,27)/rgb(212,208,202) are
// Dark Reader's default background/text. Detect it directly. Read-only.
const task = await taskSpace(30);
const page = task.page("p1");

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(4000);

console.log("=== DOM evidence of an injected restyler ===");
console.log(
  JSON.stringify(
    await page.evaluate(() => {
      const all = [...document.querySelectorAll("style,link")];
      const suspicious = all
        .filter((el) => {
          const id = (el.id || "").toLowerCase();
          const cls = (el.className || "").toString().toLowerCase();
          return (
            id.includes("dark") ||
            cls.includes("dark") ||
            id.includes("reader") ||
            cls.includes("reader") ||
            id.includes("injected")
          );
        })
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: (el.className || "").toString().slice(0, 60) || null,
          href: el.getAttribute("href"),
          head: (el.textContent || "").slice(0, 160).replace(/\s+/g, " "),
        }));
      return {
        totalStyleNodes: all.length,
        suspicious,
        // Dark Reader stamps these on <html>.
        htmlAttrs: [...document.documentElement.attributes].map(
          (a) => `${a.name}="${a.value.slice(0, 60)}"`,
        ),
        hasDarkReaderMeta: !!document.querySelector('meta[name="darkreader"]'),
        // Its CSS custom properties, if present.
        drVars: ["--darkreader-neutral-background", "--darkreader-neutral-text"].map((v) => ({
          v,
          value: getComputedStyle(document.documentElement).getPropertyValue(v),
        })),
      };
    }),
    null,
    1,
  ),
);

console.log("\n=== extension targets known to the browser ===");
try {
  const targets = await task.cdp("Target.getTargets", {});
  const list = (targets?.targetInfos ?? [])
    .filter((t) => t.type !== "page" || t.url.startsWith("chrome-extension://"))
    .map((t) => ({ type: t.type, title: t.title, url: t.url.slice(0, 90) }));
  console.log(JSON.stringify(list, null, 1));
} catch (e) {
  console.log("Target.getTargets failed:", String(e).slice(0, 200));
}
