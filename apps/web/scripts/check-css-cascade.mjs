#!/usr/bin/env node
// Issue #360 — a light token must never outrank its dark counterpart.
//
// Issue #351 folded Todo's `[data-surface="todo"]` token scope into plain
// `:root`/`.dark`. Under that scope the two halves were
// `[data-surface="todo"]` (0,1,0) and `.dark [data-surface="todo"]` (0,2,0),
// both sitting below the base blocks — so the dark half only ever had to
// carry the tokens whose values genuinely DIFFERED from the base dark ones.
// Anything equal to the base was redundant, and dropping it was correct.
//
// Folding invalidated that reasoning without changing a single value.
// `:root` and `.dark` have the SAME specificity (0,1,0), so source order
// alone decides between them — and the folded light values now live in a
// `:root` block placed BELOW the base `.dark` block. Any token that block
// sets and the folded dark block omits therefore WINS IN DARK THEME, painting
// a light value on a dark ground.
//
// `--muted` shipped that way in v0.12.0. Its Todoist dark value is
// `rgb(38,38,38)`, exactly the base `oklch(0.269 0 0)`, so it read as
// provably redundant and was dropped — and dark theme's every `bg-muted`
// surface (History's Entry bubbles, hover states, `--td-popover-background`)
// turned `rgb(246,246,246)`, near-white.
//
// This lives here, beside check-bundle-size.mjs, rather than in the vitest
// suite, for a concrete reason: vitest stubs CSS imports, so `index.css?raw`
// resolves to an empty string and any such test passes vacuously, and the
// browser-facing tsconfig excludes node's types so `node:fs` will not
// typecheck from `src/`. A plain build-time script has neither problem and
// reads the same stylesheet the build reads.
//
// The rule this enforces is therefore NOT "re-point what differs from the
// base dark values" but "re-point everything the later `:root` block sets
// that an earlier `.dark` block also sets" — whether or not the number
// changes. A `var()` value is exempt: it resolves per theme, so
// `--card: var(--background)` is correct in both.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.css");
const lines = readFileSync(CSS_PATH, "utf8").split("\n");

/**
 * Custom-property declarations of every top-level block whose selector head
 * matches `selector` exactly, in source order. Brace counting is enough here:
 * this stylesheet nests only `@media`/`@theme`, and those wrap blocks rather
 * than declaring the tokens under test — a nested block's own declarations
 * are attributed to whatever top-level block encloses them, which is exactly
 * what the cascade does too.
 */
function blocksFor(selector) {
  const found = [];
  let depth = 0;
  let current = null;

  lines.forEach((line, index) => {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (depth === 0 && opens > 0) {
      const head = line.slice(0, line.indexOf("{")).trim();
      if (head === selector) current = { decls: new Map(), startLine: index + 1 };
    }

    if (current !== null && depth >= 1) {
      const match = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
      if (match !== null) current.decls.set(match[1], match[2].trim());
    }

    depth += opens - closes;

    if (current !== null && depth === 0) {
      found.push(current);
      current = null;
    }
  });

  return found;
}

const rootBlocks = blocksFor(":root");
const darkBlocks = blocksFor(".dark");

// Guard the parser itself. If the stylesheet is ever restructured such that
// these blocks no longer exist, this script is checking nothing — and a check
// that silently stops checking is worse than no check, since its green is
// read as evidence.
if (rootBlocks.length < 2 || darkBlocks.length < 2) {
  console.error(
    `check-css-cascade: expected at least two \`:root\` and two \`.dark\` blocks in ` +
      `src/index.css, found ${rootBlocks.length} and ${darkBlocks.length}. ` +
      `The stylesheet's structure changed and this check can no longer see what ` +
      `it was written to see — update it rather than deleting it.`,
  );
  process.exit(1);
}

const offenders = [];

for (const root of rootBlocks) {
  for (const [token, value] of root.decls) {
    if (value.startsWith("var(")) continue;

    const shadowed = darkBlocks.some(
      (dark) => dark.startLine < root.startLine && dark.decls.has(token),
    );
    if (!shadowed) continue;

    const rescued = darkBlocks.some(
      (dark) => dark.startLine > root.startLine && dark.decls.has(token),
    );
    if (!rescued) offenders.push({ token, value, line: root.startLine });
  }
}

if (offenders.length > 0) {
  console.error("check-css-cascade: light values outranking dark ones.\n");
  for (const { token, value, line } of offenders) {
    console.error(
      `  ${token}\n` +
        `    \`:root\` (line ${line}) sets "${value}", a light value, below a\n` +
        `    \`.dark\` block that also sets ${token}. Same specificity, so source\n` +
        `    order wins and dark theme paints the light value.\n` +
        `    Fix: re-declare ${token} in the later \`.dark\` block, even if its\n` +
        `    value equals the base dark one — equality is the trap, not the\n` +
        `    justification.\n`,
    );
  }
  process.exit(1);
}

console.log(
  `check-css-cascade: ${rootBlocks.length} \`:root\` and ${darkBlocks.length} ` +
    `\`.dark\` blocks, no light value outranks a dark one.`,
);
