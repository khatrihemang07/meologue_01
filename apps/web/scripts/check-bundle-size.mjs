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
import { readdirSync, readFileSync } from "node:fs";
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

// --- Per-lazy-chunk budgets (issue #167) ------------------------------------
//
// The ceiling above catches weight on `/`'s own cold-start path. It was
// never going to catch anything else: Todo (issue #167 onward) is a
// Todoist-scale feature landing entirely behind App.tsx's own `React.lazy()`
// boundary, alongside ComposerPage, ReflectionPage and the rest — so every
// byte of it ships in its own chunk, never this one, and the ceiling above
// stays silent no matter how large that chunk grows. This section gives
// every lazy route a budget of its own, set *before* the code that fills it
// is written, by someone who cannot yet see what shape that growth will
// take. A route that shows up in a build with no budget entry fails the
// check outright, naming itself and asking for one — that is the whole
// point: a new lazy route cannot land, let alone grow, unmeasured.
//
// A route is measured as its own chunk **plus every shared chunk it
// statically imports**, minus what the cold start already fetched — see
// routeFiles() for why measuring a chunk alone turned out to measure the
// wrong thing, and what issue #169 did to expose it.
//
// Lazy chunks are discovered from dist/<target>/.vite/manifest.json
// (`build.manifest: true`, vite.config.ts), not hard-coded: Rollup
// content-hashes every chunk's filename, so a name like
// `composer-page-B7bpfnp7.js` changes on every build and can never be a
// budget table's key. The manifest's own keys are exactly the *source*
// path each chunk was built from (`src/pages/composer-page.tsx`) for any
// chunk that is the direct target of a dynamic `import()` and nothing
// else — Vite marks exactly those entries `isDynamicEntry: true`. A
// stable, hash-free key computed the same way regardless of what the
// chunk happens to be named this build is why the manifest is preferred
// over guessing from dist/<target>/assets — see readLazyChunksFallback
// below for what discovery looks like without one.
//
// `src/pages/entry-store-layout.tsx` is deliberately not in this set even
// though App.tsx also lazy-imports it: main.tsx statically imports
// SyncLoop (use-sync-loop.ts), which statically imports this same module
// for `entryStoreQueryOptions` — so its chunk is *also* a static
// dependency of the entry chunk, listed as a `<link rel="modulepreload">`
// in index.html and fetched unconditionally on cold start, not only when
// `/`, `/reflect` or `/digest` is reached. Vite's manifest reflects that:
// it never marks this chunk `isDynamicEntry: true`, and gives it no
// source-path key at all (only a synthetic `_entry-store-layout-<hash>.js`
// one) — exactly the signal this script relies on to tell a lazy chunk
// from an eager one. Its weight already rides on cold start the same way
// the entry chunk's own does, so it is excluded from the route budgets
// below *and* subtracted from every route's own total (`alreadyEager`),
// rather than billed to whichever route happens to be measured.
//
// The entry ceiling above still measures only the one
// `<script type="module">` file, not that file's own static imports — so
// this chunk's bytes are counted by neither check. That remains a real
// gap. It is narrower than it was: the route budgets below now walk a
// route's full static import graph (routeFiles()), so the same blind spot
// no longer exists past `/`. Closing it for the entry chunk means deciding
// what a cold start's honest total is, which is its own change.
//
// Vendor dynamic imports (four @capacitor `web.js` shims, one per native
// plugin's browser fallback) are excluded too: `isDynamicEntry` is true
// for them, but their manifest key is a node_modules path
// (`../../node_modules/...`), not first-party source under `src/`. Nobody
// here owns that code or would meaningfully "raise a budget" on it, and
// each one is under a kilobyte raw — the noise a per-chunk check like this
// one exists to keep out, not the signal it exists to catch.

const CHUNK_BUDGET_KEY_PREFIX = "src/";

/**
 * A ceiling and a measured baseline for every lazy **route** — the same
 * shape ENTRY_CHUNK_BASELINE_BYTES/CEILING_BYTES above carry for the entry
 * chunk: ~30% headroom over a real, measured number, not a round guess.
 * Re-measured 2026-09-02 against a clean `vite build --mode android`, gzip
 * via the same gzipSync() this script uses for the entry chunk (Vite's own
 * build-log gzip figures use a different setting and don't quite match
 * these).
 *
 * **Every number here changed on 2026-09-02, and the mechanism is why.**
 * These used to measure a route's own chunk *alone*, and issue #169 showed
 * that was measuring the wrong thing: adding `date-picker-sheet.tsx` to
 * Todo made Rollup lift that module into a shared chunk, and
 * `composer-page` promptly "improved" from 104,000 to 83,685 gzip bytes
 * while shipping precisely as much code as before — with ~20 KB landing in
 * a chunk that had no budget at all. A per-chunk number tracks where
 * Rollup put code; what is worth protecting is what a reader must download
 * to open a screen. The baselines below are that instead (routeFiles()),
 * so they are several times larger than the ones they replace without a
 * single byte having been added.
 */
const CHUNK_BUDGETS = {
  // Not a route — `DestructiveConfirmDialog` (components/settings/
  // destructive-confirm-dialog.tsx), lazy-loaded from both
  // data-section.tsx's Device Restore and server-data-group.tsx's Server
  // Restore (issues #195/#197/#198) rather than statically imported into
  // settings-page.tsx's own chunk. A static import there made that route
  // fail its own budget at 26,358 gzip bytes against a 17,600 ceiling —
  // Radix's `Dialog` primitive this component pulls in, unused by
  // Settings' other four topic sections, is ~11,800 of those bytes on its
  // own — the identical "keep it out of the eager chunk" reasoning
  // check-bundle-size.mjs's own header comment already gives for a route
  // whose dependency belongs behind a lazy boundary instead. Measured
  // 13,176 bytes gzip (own chunk + 2 shared) immediately after landing.
  "src/components/settings/destructive-confirm-dialog.tsx": {
    ceilingBytes: 17_200,
    baselineBytes: 13_176,
  },
  "src/components/todo/task-detail-view.tsx": {
    ceilingBytes: 73_000,
    baselineBytes: 71_474,
  },
  // Not a route — `ActivityFeed` (components/todo/activity-feed.tsx),
  // lazy from both `task-detail-view.tsx`'s own `TaskActivityDialog`
  // (issue #288) and `todo-page.tsx`'s own `backgroundView.view ===
  // "activity"` branch (issue #184) — one shared wrapper,
  // `lazy-activity-feed.ts`, the identical "one lazy chunk regardless of
  // which caller opens it first" shape `lazy-task-title-editor.ts` and
  // `lazy-destructive-confirm-dialog.ts` already use for their own
  // multi-caller components. `task-detail-view.tsx`'s own entry above has
  // the full account of why this split was necessary at both call sites
  // for either budget to actually shrink, not just move.
  //
  // Carries more than `activity-feed.tsx`'s own component code:
  // `format-event.ts`'s `describeEventLine`/`groupEventsByDay`/
  // `eventTimestamp` (the per-event-type formatter this file's caller-side
  // `isRenderableEvent` split, `lib/is-renderable-event.ts`, was pulled out
  // to stop dragging into `task-detail-view.tsx` and `todo-page.tsx`
  // instead) and `task-detail-route.ts`'s `taskDetailPath` (`SubjectChip`'s
  // own link to the Task a line is about). Measured 9,624 gzip (own chunk
  // + 4 shared) immediately after landing.
  "src/components/todo/activity-feed.tsx": {
    ceilingBytes: 12_500,
    baselineBytes: 9_624,
  },
  // Not a route — `TaskScheduleSheet` (components/todo/task-schedule-
  // sheet.tsx), lazy from `todo-page.tsx` (issue #229 onward's own
  // bundle-headroom ticket) — the identical move `task-detail-view.tsx`
  // above makes, for the identical reason (that entry's own header
  // comment has the numbers). This chunk carries more than its own ~9 KB
  // of source: it statically imports `task-schedule-popover.tsx` (issue
  // #227's Todoist-style scheduler — `date-fns` plus `ui/popover.tsx`'s
  // Radix `Popover`) and `date-picker-sheet.tsx` (react-day-picker, for
  // the Deadline field's unchanged picker), so both scheduler surfaces
  // move together, in one shared lazy chunk, rather than each growing a
  // wrapper of its own — `lazy-task-schedule-sheet.ts`'s own header
  // comment. `composer-page.tsx` keeps its own **static** import of this
  // same module — a separate route with its own, already large budget —
  // so this entry measures only what `todo-page.tsx` now pays lazily.
  // Measured 49,399 bytes gzip (own chunk + 9 shared) immediately after
  // landing.
  "src/components/todo/task-schedule-sheet.tsx": {
    ceilingBytes: 64_200,
    baselineBytes: 49_399,
  },
  // Issue #416 — raised from 3,400/2,734. #411's Mod-Enter/Cmd-Enter
  // keymap binding and #388's `/` sigil support both landed genuine new
  // code in this shared editor since the previous baseline, measuring
  // 3,610 gzip bytes (own chunk + 1 shared) on a clean `build:android`.
  // ~30% headroom above that, the same margin the other entries in this
  // table carry (e.g. `task-description-editor.tsx`,
  // `task-schedule-sheet.tsx` above), not the ~24% the original entry
  // had.
  "src/components/todo/task-title-editor.tsx": {
    ceilingBytes: 4_700,
    baselineBytes: 3_610,
  },
  "src/components/todo/task-description-editor.tsx": {
    ceilingBytes: 2_300,
    baselineBytes: 1_703,
  },
  // Not a route — `TodoSidebar` (components/todo/todo-sidebar.tsx), lazy
  // from chat-shell-layout.tsx (issue #223, ADR 0076). It has to be lazy
  // for the reason that file's own comment gives: the layout renders on
  // every route including `/`, so a static import would drag the Entry
  // store onto the one path App.tsx's cold-start boundary exists to keep
  // clear, for a reader who may never open Todo at all. Measured 37,838
  // bytes gzip (own chunk + 7 shared) immediately after landing; the
  // ceiling carries roughly the same ~30% headroom the route budgets
  // below do, which is what leaves room for the Projects tree to grow
  // real per-Project counts and controls (#229) without a budget edit
  // being the first thing that ticket has to do.
  "src/components/todo/todo-sidebar.tsx": {
    ceilingBytes: 49_000,
    baselineBytes: 37_838,
  },
  // ComposerPage carries ProseMirror plus the markdown-blocks/WYSIWYG
  // composer (issues #148-#166) — much the largest route in the app, and
  // expected to stay that way. Measured 128,032 bytes gzip across its own
  // chunk and 10 shared ones.
  "src/pages/composer-page.tsx": { ceilingBytes: 166_000, baselineBytes: 128_032 },
  // Measured 9,269 bytes gzip (own chunk + 6 shared).
  "src/pages/digest-page.tsx": { ceilingBytes: 12_000, baselineBytes: 9_269 },
  // Measured 8,333 bytes gzip (own chunk + 6 shared).
  "src/pages/digest-reader-page.tsx": { ceilingBytes: 10_800, baselineBytes: 8_333 },
  // Measured 29,316 bytes gzip (own chunk + 10 shared).
  "src/pages/reflection-page.tsx": { ceilingBytes: 38_000, baselineBytes: 29_316 },
  // Measured 20,088 bytes gzip (own chunk + 6 shared).
  "src/pages/sessions-page.tsx": { ceilingBytes: 26_000, baselineBytes: 20_088 },
  // Re-measured at 17,253 gzip after Time's source configuration landed here
  // (issues #419/#420/#423: the recorder picker, the path field and the
  // archive/re-enable control), which took the route from 13,586 to within
  // 350 bytes of its old 17,600 ceiling. Re-baselined rather than squeezed:
  // the growth is a whole topic section this page did not have before, not
  // drift. Headroom restored to the ~1.3x every other route entry uses.
  "src/pages/settings-page.tsx": { ceilingBytes: 22_400, baselineBytes: 17_253 },
  // TimePage (issue #418, comparative lanes in #420). Carries `date-fns`'s
  // date arithmetic and `lib/time-lanes.ts`'s layout maths; the lanes
  // themselves are plain absolutely-positioned elements rather than a
  // charting library, which is most of why this sits nearer Digest's size
  // than Todo's.
  //
  // Re-measured at 16,288 gzip once #421's refresh and status panel, #422's
  // nightly-run reporting and #424's day navigation, search and record
  // inspector had all landed on it — 12,708 was the first slice alone.
  // Headroom is the ~1.3x every other route entry here uses.
  "src/pages/time-page.tsx": { ceilingBytes: 21_200, baselineBytes: 16_288 },
  "src/pages/todo-page.tsx": { ceilingBytes: 92_832, baselineBytes: 92_795 },
};

/**
 * Reads .vite/manifest.json and returns the first-party lazy chunks — see
 * this section's own header comment for exactly what "first-party" and
 * "lazy" mean here and why. Returns `undefined`, not an empty array, when
 * the manifest itself is missing, so the caller can tell "no lazy chunks
 * exist" apart from "couldn't find out" and fall back accordingly.
 */
function readLazyChunksFromManifest(distDir) {
  const manifestPath = path.join(distDir, ".vite", "manifest.json");
  let manifestJson;
  try {
    manifestJson = readFileSync(manifestPath, "utf8");
  } catch {
    return undefined;
  }
  const manifest = JSON.parse(manifestJson);
  const chunks = Object.entries(manifest)
    .filter(
      ([key, entry]) => entry.isDynamicEntry === true && key.startsWith(CHUNK_BUDGET_KEY_PREFIX),
    )
    .map(([key, entry]) => ({ name: key, file: entry.file }));
  return { chunks, manifest };
}

/**
 * Every file a route actually has to fetch to run: its own chunk plus the
 * shared chunks it statically imports, transitively, minus whatever the
 * cold start already paid for.
 *
 * Measuring a route chunk *alone* looked right and was not, and issue #169
 * is what exposed it. Adding `date-picker-sheet.tsx` to Todo made Rollup
 * pull that module out of `composer-page`'s chunk into a shared one — so
 * `composer-page` "improved" from 104,000 to 83,685 gzip bytes while
 * shipping exactly as much code as before, and ~20 KB moved into a chunk
 * with no budget at all. Both halves of that are wrong in the same way: a
 * per-chunk number measures where Rollup happened to put code, and the
 * thing worth protecting is what a reader has to download to open a
 * screen.
 *
 * `imports` is the manifest's static-import edge list, so this walk
 * follows exactly what the browser must fetch before the route's own
 * module can evaluate. `dynamicImports` is deliberately NOT followed: a
 * chunk behind a further dynamic `import()` is by definition not paid for
 * at route load, which is the whole reason to put one there.
 *
 * `alreadyEager` holds the entry chunk and every `<link rel="modulepreload">`
 * in index.html — weight the cold start already fetched before any route
 * was chosen (this section's own comment on `entry-store-layout.tsx`
 * covers why that chunk is one of them). Counting it again here would bill
 * every route for bytes none of them caused.
 *
 * A shared chunk reachable from two routes is counted in *both*, which is
 * the honest answer to "what does opening this route cost from cold" for
 * each of them independently, and errs toward over-reporting rather than
 * letting weight hide in a chunk each route assumes the other paid for.
 */
function routeFiles(manifest, chunkKey, alreadyEager) {
  const files = new Set();
  const seen = new Set();
  const walk = (key) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const entry = manifest[key];
    if (!entry) {
      return;
    }
    if (!alreadyEager.has(entry.file)) {
      files.add(entry.file);
    }
    for (const imported of entry.imports ?? []) {
      walk(imported);
    }
  };
  walk(chunkKey);
  return [...files];
}

/**
 * Falls back to reading dist/<target>/index.html's own modulepreload links
 * (the entry chunk's *eager* static dependencies — the same reasoning that
 * excludes entry-store-layout.tsx above) plus a directory scan of
 * dist/<target>/assets, for the case build.manifest ever gets turned back
 * off (vite.config.ts). Deliberately a worse mechanism, not an equal
 * alternative: without the manifest there is no source path to key a
 * budget by, only the chunk's own hashed output filename, so this strips
 * the trailing content hash and hopes what remains (`composer-page`, not
 * `src/pages/composer-page.tsx`) is stable across a rebuild — usually true,
 * since Vite derives that stem from the source filename, but not
 * guaranteed the way a manifest key is. It also cannot separate a
 * first-party route chunk from a same-shaped vendor one (the four
 * @capacitor `web.js` shims this section's header comment excludes by
 * their manifest key all collide on the literal name "web" here) — a false
 * "no budget entry" failure on one of those is this path's known cost, and
 * the fix is to restore build.manifest, not to budget vendor code.
 */
function readLazyChunksFallback(distDir, entryChunkFile, indexHtmlText) {
  const preloaded = new Set(
    [...indexHtmlText.matchAll(/<link rel="modulepreload"[^>]+href="([^"]+)"/g)].map((match) =>
      match[1].replace(/^\//, ""),
    ),
  );
  const assetsDir = path.join(distDir, "assets");
  const chunks = readdirSync(assetsDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => `assets/${file}`)
    .filter((file) => file !== entryChunkFile && !preloaded.has(file))
    .map((file) => ({
      name: path.basename(file).replace(/-[A-Za-z0-9_-]{8,}\.js$/, ""),
      file,
    }));
  // No manifest means no import graph to walk, so each chunk can only be
  // measured alone — the weaker number this whole fallback is, named here
  // rather than left to look equivalent to the manifest path's.
  return { chunks, manifest: undefined };
}

const { chunks: lazyChunks, manifest } =
  readLazyChunksFromManifest(distDir) ??
  readLazyChunksFallback(distDir, entryChunkSrc.replace(/^\//, ""), indexHtml);

// What the cold start already fetched before any route was chosen: the one
// `<script type="module">` entry chunk, plus every chunk index.html
// modulepreloads. See routeFiles() for why a route must not be billed for
// these a second time.
const alreadyEager = new Set([
  entryChunkSrc.replace(/^\//, ""),
  ...[...indexHtml.matchAll(/<link rel="modulepreload"[^>]+href="([^"]+)"/g)].map((match) =>
    match[1].replace(/^\//, ""),
  ),
]);

let anyChunkFailed = false;

for (const chunk of lazyChunks) {
  // The route's whole cost, not just its own chunk's — see routeFiles()
  // for what issue #169 taught about the difference. Without a manifest
  // there is no import graph to walk, so the fallback path measures the
  // chunk alone and says so in its output.
  const files = manifest ? routeFiles(manifest, chunk.name, alreadyEager) : [chunk.file];
  let chunkRawBytes = 0;
  let chunkGzipBytes = 0;
  for (const file of files) {
    const raw = readFileSync(path.join(distDir, file));
    chunkRawBytes += raw.length;
    // Each file gzipped on its own, then summed, rather than gzipping the
    // concatenation: that is what the browser actually receives, one
    // compressed response per file, with no shared dictionary between
    // them. Concatenating first would report a smaller, unachievable
    // number.
    chunkGzipBytes += gzipSync(raw).length;
  }
  const budget = CHUNK_BUDGETS[chunk.name];
  const shared = files.length - 1;

  console.log(
    `check-bundle-size: route ${chunk.name} (${path.basename(chunk.file)}${shared > 0 ? ` + ${shared} shared` : ""})`,
  );
  console.log(`  raw:  ${chunkRawBytes.toLocaleString()} bytes`);
  if (budget) {
    console.log(
      `  gzip: ${chunkGzipBytes.toLocaleString()} bytes (ceiling ${budget.ceilingBytes.toLocaleString()}, baseline ${budget.baselineBytes.toLocaleString()})`,
    );
  } else {
    console.log(`  gzip: ${chunkGzipBytes.toLocaleString()} bytes (no budget entry)`);
  }

  if (!budget) {
    anyChunkFailed = true;
    console.error(
      `check-bundle-size: ${chunk.name} has no entry in CHUNK_BUDGETS (scripts/check-bundle-size.mjs) — every lazy chunk needs one, or it grows unmeasured the way nothing but the entry chunk used to be measured at all (see this file's own comment). Add one for ${chunk.name}, set from this build's own measured gzip size (${chunkGzipBytes.toLocaleString()} bytes) with headroom comparable to the other budgets in that table.`,
    );
    continue;
  }

  if (chunkGzipBytes > budget.ceilingBytes) {
    anyChunkFailed = true;
    console.error(
      `check-bundle-size: ${chunk.name} — ${chunkGzipBytes.toLocaleString()} gzip bytes exceeds its ${budget.ceilingBytes.toLocaleString()}-byte budget by ${(chunkGzipBytes - budget.ceilingBytes).toLocaleString()} bytes.`,
    );
    console.error(
      `  If this chunk genuinely needs to be this size, raise its ceilingBytes in CHUNK_BUDGETS deliberately in the same commit, with a comment recording the new measured baseline and why. If it doesn't, something that should have stayed out of ${chunk.name} — a dependency that belongs behind its own lazy boundary, or in a different route entirely — is being pulled in here instead.`,
    );
  }
}

if (anyChunkFailed) {
  process.exit(1);
}
