#!/usr/bin/env node
// Issue #411 — pins the ONE fact vitest/tsc structurally cannot see about
// this stylesheet: what colour a recognised natural-language match (a
// typed "tod", a picked date) actually paints, per theme.
//
// This lives here, beside check-css-cascade.mjs and check-bundle-size.mjs,
// for the identical reason check-css-cascade.mjs's own header comment
// gives: vitest stubs CSS imports (`index.css?raw` resolves to an empty
// string, so a vitest test asserting a literal value would pass
// vacuously), and the browser-facing tsconfig excludes node's types, so
// `node:fs` won't typecheck from `src/`. A plain build-time script reads
// the same stylesheet the build reads and has neither problem.
//
// What this DOES prove: the literal source values `:root` and `.dark`
// carry for `--td-recognition-background`/`--td-recognition-foreground`,
// and that `.td-recognition-match` declares `cursor: pointer`. What it
// does NOT prove: what those resolve to once the cascade, `@theme
// inline`, and a real compositor are involved — check-css-cascade.mjs's
// own invariant (a light value never outranking a dark one via source
// order) covers the cascade half; this script covers "are these the
// right numbers at all," which check-css-cascade.mjs deliberately does
// not ask. Neither substitutes for looking at a rendered pixel.
//
// Before issue #411, `:root` carried the DARK preset's own maroon
// unconditionally, with no `.dark` override at all — this script would
// have failed loudly on that shape (LIGHT_BACKGROUND wouldn't have
// matched), which is the "test that fails before the fix" this ticket's
// own acceptance criteria asks every defect to have.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.css");
const css = readFileSync(CSS_PATH, "utf8");
const lines = css.split("\n");

/**
 * Custom-property declarations of every top-level block whose selector head
 * matches `selector` exactly, in source order — the identical brace-
 * counting parse check-css-cascade.mjs's own `blocksFor` uses (duplicated
 * rather than imported: that module runs its own checks, and exiting the
 * process, at import time).
 */
function blocksFor(selector) {
  const found = [];
  let depth = 0;
  let current = null;

  lines.forEach((line) => {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (depth === 0 && opens > 0) {
      const head = line.slice(0, line.indexOf("{")).trim();
      if (head === selector) current = new Map();
    }

    if (current !== null && depth >= 1) {
      const match = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
      if (match !== null) current.set(match[1], match[2].trim());
    }

    depth += opens - closes;

    if (current !== null && depth === 0) {
      found.push(current);
      current = null;
    }
  });

  return found;
}

/** The declared value of `token` in the LAST block matching `selector` that
 * sets it — "last" because both `:root` and `.dark` are split across
 * several blocks in this file, and a later block's own declaration is the
 * one the cascade actually resolves to within that selector (assuming
 * check-css-cascade.mjs's own invariant already holds — this script
 * doesn't re-derive the cascade, only reads the source). */
function lastValue(selector, token) {
  const blocks = blocksFor(selector);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const value = blocks[i].get(token);
    if (value !== undefined) return value;
  }
  return undefined;
}

const offenders = [];

function expect(selector, token, expected) {
  const actual = lastValue(selector, token);
  if (actual !== expected) {
    offenders.push({ selector, token, expected, actual: actual ?? "(not set)" });
  }
}

// web/07-native-colours.md's own "Todoist" (light) table.
expect(":root", "--td-recognition-background", "rgb(253, 231, 216)");
expect(":root", "--td-recognition-foreground", "rgb(32, 32, 32)");

// web/07-native-colours.md's own "Dark" preset table — unchanged by
// issue #411, re-declared in `.dark` rather than left to fall through.
expect(".dark", "--td-recognition-background", "rgb(111, 38, 37)");
expect(".dark", "--td-recognition-foreground", "rgb(255, 255, 255)");

if (offenders.length > 0) {
  console.error("check-quick-add-recognition-colours: wrong value(s).\n");
  for (const { selector, token, expected, actual } of offenders) {
    console.error(`  ${selector} { ${token} }\n    expected "${expected}", found "${actual}"\n`);
  }
  process.exit(1);
}

// Issue #411, defect 4: the span is genuinely clickable (click-to-reject,
// issue #371) but carried no cursor affordance. Textual, not resolved —
// this only proves the declaration exists in the rule, not that a real
// browser paints a pointer cursor over it.
const matchRuleStart = lines.findIndex((line) => line.trim() === ".td-recognition-match {");
if (matchRuleStart === -1) {
  console.error(
    "check-quick-add-recognition-colours: could not find `.td-recognition-match {` in " +
      "src/index.css — the rule this check exists to inspect appears to have moved or been " +
      "renamed. Update this script rather than deleting it.",
  );
  process.exit(1);
}
const matchRuleEnd = lines.findIndex((line, i) => i > matchRuleStart && line.trim() === "}");
const matchRuleBody = lines.slice(matchRuleStart + 1, matchRuleEnd).join("\n");
if (!/cursor:\s*pointer\s*;/.test(matchRuleBody)) {
  console.error(
    "check-quick-add-recognition-colours: `.td-recognition-match` no longer declares " +
      "`cursor: pointer` — issue #411's defect 4 would regress silently.",
  );
  process.exit(1);
}

console.log(
  "check-quick-add-recognition-colours: recognition pill colours (light + dark) and cursor " +
    "affordance all match their measured/expected values.",
);
