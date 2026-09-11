#!/usr/bin/env node
/**
 * Issue #230: renders `docs/reference/composer-parity.md` from
 * `apps/web/src/lib/parity/parity-fixture.ts` — the fixture the Playwright
 * replay suite (`apps/e2e/tests/composer-parity.spec.ts`) also reads, so the
 * doc can never drift from what the suite actually asserts. There is no
 * precedent elsewhere in this repo for generating a Markdown doc from data,
 * so this script stays deliberately simple: read the fixture, render each
 * row as a small section, write the file. No templating engine, no partial
 * regeneration, no caching — run it again and the whole file is rebuilt.
 *
 * The fixture is TypeScript, and this script needs to import it with the
 * SAME module resolution `tsc`/Vite/Vitest already give it (bare `@/…`
 * aliases elsewhere in this package, extensionless relative imports
 * throughout) — plain Node's own type-stripping resolves neither. Vite
 * already knows how to do both and is already a devDependency of this
 * package, so this script asks Vite for a bare SSR module loader
 * (`configFile: false`, no plugins) rather than adding a second TS runtime
 * as a new dependency just for this one script.
 *
 * Usage: `node scripts/generate-parity-doc.mjs` (or `pnpm run generate:parity-doc`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const webRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..", "..");
const outputPath = path.join(repoRoot, "docs", "reference", "composer-parity.md");

async function loadFixture() {
  const server = await createServer({
    configFile: false,
    root: webRoot,
    server: { middlewareMode: true },
    logLevel: "error",
    // This script only ever loads one small, plugin-free module graph
    // (parity-fixture.ts -> canonical.ts -> entry-document.ts -> …) — never
    // the app's own entry points — so Vite's own dependency SCANNER (which
    // crawls index.html/main.tsx looking for what to pre-bundle) has
    // nothing useful to find here and only produces a noisy "could not
    // resolve @/…" warning for the app's OWN unrelated imports. Turning it
    // off skips that crawl entirely rather than suppressing its output.
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const mod = await server.ssrLoadModule("/src/lib/parity/parity-fixture.ts");
    return mod.PARITY_FIXTURE;
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Rendering one CanonicalDocument as a small, readable outline — not JSON.
// ---------------------------------------------------------------------------

function renderMarks(marks) {
  return marks.length === 0 ? "" : `[${marks.join(",")}]`;
}

function renderInline(node) {
  switch (node.kind) {
    case "text":
      return `"${node.text}"${renderMarks(node.marks)}`;
    case "reference":
      return `reference(${node.raw})${renderMarks(node.marks)}`;
    case "taskReference":
      return `taskReference(${node.label}, checked=${node.checked})${renderMarks(node.marks)}`;
    default:
      return String(node);
  }
}

function renderLine(line) {
  return line.length === 0 ? "(empty)" : line.map(renderInline).join(" ");
}

function renderProse(prose, indent) {
  const pad = "  ".repeat(indent);
  const lines = [];
  prose.lines.forEach((line, index) => {
    lines.push(`${pad}${renderLine(line)}`);
    const brk = prose.breaks[index];
    if (brk !== undefined) {
      lines.push(`${pad}⟨${brk} break⟩`);
    }
  });
  return lines.join("\n");
}

function renderBlock(block, indent) {
  if (block.kind === "prose") {
    return renderProse(block.prose, indent);
  }
  const pad = "  ".repeat(indent);
  return block.items
    .map((item) => {
      const marker = item.listKind === "ordered" ? "1." : "-";
      const checkedNote = item.checked === null ? "" : ` [checked=${item.checked}]`;
      const itemPad = pad + "  ".repeat(item.level);
      const rendered = renderProse(item.prose, 0).split("\n").join(`\n${itemPad}  `);
      return `${itemPad}${marker} (level ${item.level})${checkedNote} ${rendered}`;
    })
    .join("\n");
}

function renderDocument(doc) {
  if (doc.blocks.length === 0) {
    return "(no blocks)";
  }
  return doc.blocks.map((block) => renderBlock(block, 0)).join("\n---\n");
}

function renderKeystroke(step) {
  if (step.kind === "type") {
    return `type(${JSON.stringify(step.text)})`;
  }
  if (step.kind === "key") {
    return step.times === undefined ? `key(${step.key})` : `key(${step.key}) ×${step.times}`;
  }
  return "settle caret to line start";
}

function renderRow(row) {
  const lines = [];
  lines.push(`## ${row.id}`);
  lines.push("");
  lines.push(`**Context:** ${row.context}`);
  if (row.platform !== undefined) {
    lines.push("");
    lines.push(`**Platform:** ${row.platform}`);
  }
  lines.push("");
  lines.push(
    `**Divergence:** ${row.divergence}${row.replayable === false ? " · not replayable" : ""}`,
  );
  if (row.reason !== undefined) {
    lines.push("");
    lines.push(`**Why:** ${row.reason}`);
  }
  lines.push("");
  lines.push(`**Source:** ${row.source}`);
  lines.push("");
  lines.push("**Keystrokes:**");
  lines.push("```");
  lines.push(
    row.keystrokes.length === 0
      ? "(none — not replayable)"
      : row.keystrokes.map(renderKeystroke).join("\n"),
  );
  lines.push("```");
  lines.push("");
  lines.push("**Expected (this repo):**");
  lines.push("```");
  lines.push(renderDocument(row.expected));
  lines.push("```");
  lines.push("");
  lines.push("**UpNote (observed):**");
  lines.push("```");
  lines.push(renderDocument(row.upnote));
  lines.push("```");
  if (row.screenshots !== undefined && row.screenshots.length > 0) {
    lines.push("");
    lines.push(`**Screenshots:** ${row.screenshots.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderDoc(rows) {
  const replayableCount = rows.filter((row) => row.replayable !== false).length;
  const deliberateCount = rows.filter((row) => row.divergence === "deliberate").length;
  const noneCount = rows.length - deliberateCount;

  const header = [
    "# Composer / UpNote parity matrix",
    "",
    "Generated by `apps/web/scripts/generate-parity-doc.mjs` from",
    "`apps/web/src/lib/parity/parity-fixture.ts` — do not edit this file by hand,",
    "edit the fixture and regenerate (`pnpm --filter @meologue/web run generate:parity-doc`).",
    "",
    `${rows.length} rows total — ${replayableCount} replayed by`,
    "`apps/e2e/tests/composer-parity.spec.ts`, " +
      `${rows.length - replayableCount} kept for citation only.`,
    `${noneCount} rows claim parity (\`divergence: "none"\`) against UpNote's own`,
    `observed behaviour; ${deliberateCount} record a deliberate, reasoned divergence`,
    "(see ADR 0072).",
    "",
    "Each row's canonical form is rendered as an outline: one line per line of",
    "prose or list item, `⟨block break⟩`/`⟨soft break⟩` between lines where one",
    "exists, and `(level N)` naming a list item's own flattened nesting depth —",
    "see `apps/web/src/lib/parity/canonical.ts`'s own module comment for what",
    "the shape means and why both apps normalize to it.",
    "",
    "---",
    "",
  ].join("\n");

  return header + rows.map(renderRow).join("\n---\n\n");
}

async function main() {
  const rows = await loadFixture();
  const content = renderDoc(rows);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  console.log(`Wrote ${rows.length} rows to ${path.relative(repoRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
