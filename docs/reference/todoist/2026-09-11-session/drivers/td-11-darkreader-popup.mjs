// Todoist capture pass 2 — STEP 11: reach Dark Reader's own UI so it can be
// turned off for app.todoist.com. Confirmed present via
// data-darkreader-proxy-injected="true" and extension id
// eimadpbcbfnmbkopoojfekhnkhdbieeh. This step only INSPECTS the popup and
// reports its controls; it changes nothing yet.
const task = await taskSpace(30);
const EXT = "eimadpbcbfnmbkopoojfekhnkhdbieeh";

// Use a second page so the Todoist tab keeps its state.
let page;
const existing = await task.pages();
const spare = existing.find((p) => p.label !== "p1");
page = spare ?? (await task.newPage());
console.log("using page:", page.label);

const candidates = [
  `chrome-extension://${EXT}/ui/popup/index.html`,
  `chrome-extension://${EXT}/ui/options/index.html`,
  `chrome-extension://${EXT}/ui/stylesheet-editor/index.html`,
];

for (const url of candidates) {
  try {
    await page.goto(url);
    await page.waitForLoadState();
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => ({
      title: document.title,
      bodyLen: document.body.innerText.length,
      text: document.body.innerText.slice(0, 400).replace(/\n+/g, " | "),
      controls: [...document.querySelectorAll("button,input,a,[role='button'],[class*='toggle']")]
        .map((el) =>
          (el.getAttribute("aria-label") || el.innerText || el.className || "")
            .toString()
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 60),
        )
        .filter(Boolean)
        .slice(0, 40),
    }));
    console.log(`\n=== ${url} ===`);
    console.log(JSON.stringify(info, null, 1));
    if (info.bodyLen > 0) {
      console.log("--- snapshot ---");
      console.log(await page.snapshot());
      break;
    }
  } catch (e) {
    console.log(`\n${url} -> FAILED: ${String(e).slice(0, 140)}`);
  }
}
