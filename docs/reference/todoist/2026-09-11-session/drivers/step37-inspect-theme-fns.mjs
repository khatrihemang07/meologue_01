const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const info = await page.evaluate(() => {
  const out = {};
  try {
    out.getThemeQueryParamSrc = window.getThemeQueryParam.toString().slice(0, 1500);
  } catch (e) {
    out.getThemeQueryParamErr = String(e);
  }
  try {
    out.getThemeQueryParamResult = window.getThemeQueryParam();
  } catch (e) {
    out.getThemeQueryParamResultErr = String(e);
  }
  try {
    out.initThemeSrc = window.initTheme.toString().slice(0, 800);
  } catch (e) {
    out.initThemeErr = String(e);
  }
  try {
    out.changeThemeByThemeNameSrc = window.changeThemeByThemeName.toString().slice(0, 1500);
  } catch (e) {
    out.changeThemeByThemeNameErr = String(e);
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
await fs.writeFile(`${OUT}/td-theme-fns.json`, JSON.stringify(info, null, 2));
