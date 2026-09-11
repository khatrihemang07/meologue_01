const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const info = await page.evaluate(() => {
  const results = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      continue;
    }
    const scan = (ruleList) => {
      for (const rule of ruleList) {
        if (rule.type === CSSRule.MEDIA_RULE && /prefers-color-scheme/i.test(rule.conditionText || rule.media?.mediaText || "")) {
          // look inside for theme_todoist selectors
          for (const inner of rule.cssRules) {
            if (inner.selectorText && /theme_todoist/i.test(inner.selectorText)) {
              results.push({
                media: rule.conditionText || rule.media.mediaText,
                selector: inner.selectorText,
                cssText: inner.cssText.slice(0, 500),
              });
            }
          }
        } else if (rule.type === CSSRule.SUPPORTS_RULE || rule.type === CSSRule.MEDIA_RULE) {
          try {
            scan(rule.cssRules);
          } catch (e) {}
        }
      }
    };
    try {
      scan(rules);
    } catch (e) {}
  }
  return { count: results.length, results: results.slice(0, 20) };
});
console.log(JSON.stringify(info, null, 2));
await fs.writeFile(`${OUT}/td-css-media-rules.json`, JSON.stringify(info, null, 2));
