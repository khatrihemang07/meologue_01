#!/usr/bin/env node
// Issue #150 — the build measures its own size.
//
// The Android target has no service worker: register-service-worker.android.ts
// is a deliberate no-op (vite.config.ts's own comment explains why only "web"
// gets one), so nothing has ever warmed a cache before the WebView asks for the
// entry chunk on cold start. Every gzipped byte here is parsed and evaluated
// before the app can paint. Nothing in this repo measured that before this
// script existed, so a regression — a new dependency, an accidental static
// import of something that should have stayed behind App.tsx's lazy boundary —
// would have shipped silently. This asserts it instead.
//
// The chunk to measure is read out of dist/<target>/index.html rather than
// guessed by filename pattern: Rollup content-hashes every chunk, so the name
// changes on every build, but the entry point index.html's build actually
// loads never does — it is always the one <script type="module"> tag Vite
// injects for the entry.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Measured 2026-08-31, immediately after this ticket's own App.tsx lazy split
// landed (React.lazy on every route past `/`, so ChatListPage's cold start no
// longer pulls in @meologue/core's `open()`, the sqlite driver, or any other
// page). Before that split the whole app was one 218,000-byte-gzip chunk
// (issue #150's own numbers, from a build with no code splitting at all);
// afterwards the entry chunk alone gzipped to ENTRY_CHUNK_BASELINE_BYTES
// below — a ~72% cut, because almost everything that made up the old 218 KB
// was page code and the sqlite driver, neither of which `/` needs.
const ENTRY_CHUNK_BASELINE_BYTES = 60_223;

// ~30% headroom above that baseline: enough that normal dependency churn (a
// lockfile bump, an icon added to lucide-react's tree-shaken import) does not
// fail a build it shouldn't, but tight enough that a meaningful new static
// import landing on the cold-start path still trips it.
//
// Issue #155's ProseMirror composer (~69 KB gzip) should NOT be the thing
// that raises this number: it lands inside ComposerPage, which is already
// behind the lazy boundary above and so ships in composer-page's own chunk,
// never this one — that is what "off the cold-start path" in issue #150
// means. If adding it ever does move this number, that is this ceiling
// catching a real regression (ComposerPage's import having come loose from
// the lazy boundary), not a false alarm to raise the ceiling past. A
// deliberate ceiling raise here should only ever be for weight that
// genuinely belongs on `/`'s own cold-start path.
const CEILING_BYTES = 78_000;

const target = process.argv[2] ?? "android";
const distDir = path.resolve(fileURLToPath(import.meta.url), "..", "..", "dist", target);
const indexHtmlPath = path.join(distDir, "index.html");

let indexHtml;
try {
  indexHtml = readFileSync(indexHtmlPath, "utf8");
} catch {
  console.error(
    `check-bundle-size: could not read ${indexHtmlPath} — run the ${target} build first.`,
  );
  process.exit(1);
}

const scriptMatch = indexHtml.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
if (!scriptMatch) {
  console.error(`check-bundle-size: no <script type="module"> tag found in ${indexHtmlPath}.`);
  process.exit(1);
}

const entryChunkSrc = scriptMatch[1];
if (entryChunkSrc === undefined) {
  console.error(`check-bundle-size: matched script tag in ${indexHtmlPath} had no src.`);
  process.exit(1);
}
const entryChunkPath = path.join(distDir, entryChunkSrc.replace(/^\//, ""));

const raw = readFileSync(entryChunkPath);
const gzipBytes = gzipSync(raw).length;

console.log(`check-bundle-size: ${target} entry chunk ${path.basename(entryChunkPath)}`);
console.log(`  raw:  ${raw.length.toLocaleString()} bytes`);
console.log(
  `  gzip: ${gzipBytes.toLocaleString()} bytes (ceiling ${CEILING_BYTES.toLocaleString()}, baseline ${ENTRY_CHUNK_BASELINE_BYTES.toLocaleString()})`,
);

if (gzipBytes > CEILING_BYTES) {
  console.error(
    `check-bundle-size: ${gzipBytes.toLocaleString()} gzip bytes exceeds the ${CEILING_BYTES.toLocaleString()}-byte ceiling by ${(gzipBytes - CEILING_BYTES).toLocaleString()} bytes.`,
  );
  console.error(
    "  If this is expected new weight on the cold-start path (see this script's own comment), raise CEILING_BYTES deliberately in the same commit. If it isn't, something that should be behind App.tsx's lazy boundary is being imported statically instead.",
  );
  process.exit(1);
}
