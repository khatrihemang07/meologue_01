const task = await taskSpace(30);
const page = task.page("p1");

const info = await page.evaluate(() => {
  // themeNameMapping is referenced inside initTheme's closure; try to find
  // it as a module-scope var exposed on window or via webpack chunks. Try
  // common globals first.
  const candidates = ["themeNameMapping"];
  const found = {};
  for (const name of candidates) {
    if (window[name]) found[name] = window[name];
  }
  return { found, hasWindowThemeNameMapping: typeof window.themeNameMapping };
});
console.log(JSON.stringify(info));
