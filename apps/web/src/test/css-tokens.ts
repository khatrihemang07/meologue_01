/**
 * A small, deliberately dumb parser for `index.css`'s own `:root`/`.dark`
 * custom-property blocks — reads declared values, not resolved ones
 * (`getComputedStyle` never runs; there is no browser here), the same
 * brace-counting approach `check-css-cascade.mjs`'s own `blocksFor` uses,
 * kept simple on purpose ("robust to formatting", not to a stylesheet
 * restructure) rather than pulling in a real CSS parser for a handful of
 * flat custom-property declarations.
 */
function blocksFor(lines: readonly string[], selector: string): Array<Map<string, string>> {
  const found: Array<Map<string, string>> = [];
  let depth = 0;
  let current: Map<string, string> | null = null;

  for (const line of lines) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (depth === 0 && opens > 0) {
      const head = line.slice(0, line.indexOf("{")).trim();
      if (head === selector) {
        current = new Map();
      }
    }

    if (current !== null && depth >= 1) {
      const match = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
      const token = match?.[1];
      const value = match?.[2];
      if (token !== undefined && value !== undefined) {
        current.set(token, value.trim());
      }
    }

    depth += opens - closes;

    if (current !== null && depth === 0) {
      found.push(current);
      current = null;
    }
  }

  return found;
}

/**
 * The final declared value of every custom property in every `:root`/
 * `.dark` block, in FILE order — later blocks win over earlier ones for
 * the same property, mirroring the real cascade for two selectors of
 * identical specificity (`check-css-cascade.mjs`'s own header comment has
 * the full reasoning this app leans on elsewhere). `dark` falls back to
 * `light`'s own value for any token `.dark` never re-declares — the same
 * "inherits unless overridden" rule that makes `check-css-cascade.mjs`
 * necessary at all.
 */
export function parseThemeTokens(cssText: string): {
  light: ReadonlyMap<string, string>;
  dark: ReadonlyMap<string, string>;
} {
  const lines = cssText.split("\n");
  const light = new Map<string, string>();
  for (const block of blocksFor(lines, ":root")) {
    for (const [token, value] of block) {
      light.set(token, value);
    }
  }
  const dark = new Map<string, string>(light);
  for (const block of blocksFor(lines, ".dark")) {
    for (const [token, value] of block) {
      dark.set(token, value);
    }
  }
  return { light, dark };
}

/**
 * Resolves a token's own value in `theme`, following a single `var(--x)`
 * reference (`--td-schedule-later-this-week`'s own shape) to whatever `--x`
 * itself resolves to in the SAME theme map — depth-limited defensively
 * against a cycle no test here is meant to exercise.
 */
export function resolveToken(
  theme: ReadonlyMap<string, string>,
  token: string,
  maxDepth = 5,
): string | undefined {
  let value = theme.get(token);
  for (let i = 0; i < maxDepth && value !== undefined; i++) {
    const match = /^var\((--[\w-]+)\)$/.exec(value);
    const referenced = match?.[1];
    if (referenced === undefined) {
      return value;
    }
    value = theme.get(referenced);
  }
  return value;
}
