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
  // Not a route — `TaskDetailView` (components/todo/task-detail-view.tsx),
  // lazy from `todo-page.tsx` alone (issue #229 onward's own bundle-
  // headroom ticket). Unlike every other entry in this table, this
  // component was never a *shared* dependency of more than one caller —
  // it renders only behind `/todo/task/:taskSlugId`, gated by the
  // identical `openTask !== null` check that already existed before this
  // split — so moving it doesn't amortise weight across two surfaces the
  // way `task-title-editor.tsx` below does; it simply stops billing every
  // Todo visit for a view a reader browsing a list never needs. Landed
  // because Todo's route measured 86,949 gzip bytes against its 87,600
  // ceiling right before this ticket (651 bytes of headroom — nowhere
  // near enough for issue #228's keyboard layer or issue #229's detail
  // modal/project/label/filter management, both still landing on this
  // route). Measured 27,170 bytes gzip (own chunk + 11 shared)
  // immediately after landing.
  //
  // Issues #247-#254 took this to **58,089 gzip (own chunk + 11 shared)**,
  // and the shape of that number matters more than its size: **this
  // chunk's own code is only 4,266 bytes.** Everything else is shared
  // chunks the walk now reaches — chiefly
  // `todo-quick-add-recognition-*.js` (17,615) and `calendar-*.js`
  // (15,049), which together account for essentially the whole rise. Both
  // are ALSO reached by `src/pages/todo-page.tsx` below, and this table
  // bills a shared chunk to every entry that reaches it, so these bytes
  // are counted twice across this file while existing once in the
  // artifact. Verified against `.vite/manifest.json` rather than assumed:
  // exactly one `calendar-*.js` and one `todo-quick-add-recognition-*.js`
  // are emitted.
  //
  // Ceiling raised to 62,000 rather than splitting anything, because there
  // is nothing here a split would remove: the detail view genuinely needs
  // recognition (the rename door, #247) and the scheduler (its anchored
  // Date attribute, #253), and both already live in shared chunks another
  // surface pulls in regardless. A `lazy()` around either would move bytes
  // between budgets without removing one byte from what a reader
  // downloads.
  //
  // **Deliberately NOT attributed to a single ticket.** One reading of
  // this number blamed popover duplication and the manifest disproved it;
  // a second blamed #247's recognition import, but the reachability trace
  // behind that claim used a shared visited-set, so it showed one path
  // rather than the cause. What was measured is recorded; what was not,
  // is not.
  //
  // Issues #255-#261 (PR #259) took this to **68,138 gzip (own chunk + 11
  // shared)**, and once again almost none of it is this chunk's own code —
  // that grew 4,266 -> 5,017. The whole movement is one shared chunk:
  // `todo-quick-add-recognition-*.js` went 17,615 -> 26,323 (+8,708) when
  // `SCHED-14`'s Repeat menu and `SCHED-11`'s Time dialog landed inside the
  // scheduler it already carried (grep confirms "Repeat" in that chunk and
  // not in this one). Because this table bills a shared chunk to every entry
  // that reaches it, that single +8,708 is why TWO budgets failed in the same
  // build — this one and `src/pages/todo-page.tsx` below. The bytes exist
  // once in the artifact.
  //
  // Ceiling raised to 73,000: ~7% over the measured number, deliberately
  // tight in the same way the 62,000 before it was. A split still removes
  // nothing — the scheduler is reached by both surfaces regardless, so a
  // `lazy()` would move bytes between budgets rather than out of the
  // download.
  //
  // **Issue #288's bundle follow-up.** Issue #288 moved `ActivityFeed` off
  // this view's own always-rendered body and behind a "View activity"
  // overflow item, opening it in a new `TaskActivityDialog` instead — but
  // left `ActivityFeed` a **static** import (`task-detail-view.tsx`'s own
  // top-level `import`), so every reader still downloaded it regardless of
  // whether they ever opened that dialog. Measured at 73,130 gzip against
  // this entry's 73,000 ceiling — the build this ticket started from.
  //
  // Before reaching for `lazy()`, this entry's own history above already
  // warns that a shared-chunk split can "move bytes between budgets rather
  // than out of the download" — so that was checked, not assumed.
  // `todo-page.tsx` below turned out to statically import the identical
  // `ActivityFeed` too, unconditionally, inside its own `backgroundView.view
  // === "activity"` branch (issue #184) — and since this route can only
  // ever be reached after `todo-page.tsx` has already loaded (`todo-
  // page.tsx` is what dynamically imports `LazyTaskDetailView` in the first
  // place), a `lazy()` boundary on this file's own import ALONE would have
  // saved nothing: `todo-page.tsx`'s own eager import already guaranteed
  // `ActivityFeed`'s bytes were downloaded before a reader could ever open
  // this dialog. Both call sites had to go lazy together, through one
  // shared `LazyActivityFeed` wrapper (`lazy-activity-feed.ts`), for the
  // boundary to remove anything real — verified against `todo-page.tsx`'s
  // own entry below, which dropped too.
  //
  // That alone made this entry **worse** at first measurement — 73,598
  // gzip, +468 over the 73,130 this ticket started from — because this
  // file's own static `isRenderableEvent` import (for the `renderableEvents`
  // count behind the dialog's own "Activity (N)" title, computed here, not
  // inside `ActivityFeed`) lived in the same `format-event.ts` module as
  // `describeEventLine`'s ~240-line per-event-type formatter, which only
  // `ActivityFeed` needs. Rollup bundles a module as one atomic unit per
  // chunk, so that one still-static named import kept dragging the rest of
  // `format-event.ts` into this chunk regardless of `ActivityFeed` itself
  // going lazy — `lib/is-renderable-event.ts`'s own header comment has the
  // full account. Splitting that one predicate into its own dependency-free
  // module (`lib/is-renderable-event.ts`) let `format-event.ts` leave this
  // chunk entirely, landing at **71,474 gzip (own chunk + 15 shared)** —
  // 1,656 bytes below the 73,130 this ticket started from, with `Activity
  // (N)` still rendering synchronously (verified: `renderableEvents.length`
  // is computed in this file, not read from the lazy-loaded feed).
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
  // Not a route — `TaskTitleEditor` (components/todo/task-title-editor.tsx),
  // lazy from both `task-row-content.tsx`'s inline rename and
  // `task-detail-view.tsx`'s title (issue #225) — the identical
  // "keep it out of the eager chunk" move `destructive-confirm-dialog.tsx`
  // above already made, for the identical reason: Todo's own route
  // measured 81,251 gzip bytes against an 87,600 ceiling right before this
  // ticket (issue #225's own GitHub comment), 6,349 bytes of headroom —
  // nowhere near enough for ProseMirror
  // (`prosemirror-state`/`-view`/`-model`/`-keymap`/`-history`), even
  // though every one of those packages already ships in this app for the
  // Composer. A static import of `task-title-editor.tsx` from anywhere
  // Todo's own route reaches would have landed that whole weight on Todo's
  // number in full. Measured 1,088 bytes gzip (own chunk, no shared chunk
  // of its own) immediately after landing — this file's own module
  // comment on why the schema is deliberately smaller than `entrySchema`
  // is most of why that number is this small. Ceiling carries the same
  // ~30%+ headroom every budget in this table does.
  //
  // One open question this ticket's own report names rather than hides:
  // `composer-page.tsx`'s own entry below is separately already known to
  // read roughly half its recorded baseline (a discrepancy an earlier
  // ticket's own GitHub comment already flagged and left open — "either
  // chunking changed materially or that baseline is stale"), which raises
  // the possibility that some ProseMirror-adjacent vendor weight is
  // landing in a chunk neither route's own number currently walks. This
  // entry is measured with the identical methodology every other one in
  // this table uses; it has not been separately audited against that open
  // question.
  //
  // **2.5x on one ticket, and the cause is entirely legible.** `QA-14`
  // (PR #259) put Todoist's `#` project and `@` label autocomplete inside
  // this editor, so the popup now ships wherever a title is edited — the
  // Quick Add field, the row rename and the detail title, which is the point
  // of it living here rather than in three places. Measured 2,734 gzip bytes
  // (own chunk, no shared), up from 1,088; both "Project not found" and
  // "Label not found" grep to this chunk and to no other.
  //
  // Ceiling raised to 3,400 — ~24% over the measured number, so this entry
  // sits below this section's ~30% norm too, for a different reason than the
  // two Todo chunks above: at this size the norm would buy 820 bytes, which
  // is noise rather than headroom. A small chunk with a real feature in it is
  // still small; what this entry is guarding against is this file quietly
  // becoming a second home for scheduler or recognition weight, and 3,400
  // still catches that.
  "src/components/todo/task-title-editor.tsx": {
    ceilingBytes: 3_400,
    baselineBytes: 2_734,
  },
  // Not a route — `TaskDescriptionEditor` (components/todo/task-description-
  // editor.tsx), lazy from `task-detail-view.tsx` alone (issue #229,
  // DET-11/DET-12) — this file's own header comment on why it is a
  // bespoke, minimal ProseMirror schema rather than `entrySchema`
  // (`composer-editor.ts`'s ~69 KB gzip would have blown
  // `task-detail-view.tsx`'s own budget many times over). Reuses
  // `prosemirror-state`/`-view`/`-model`/`-keymap`/`-history` already
  // shared with `task-title-editor.tsx` above; its own marginal weight is
  // just its schema, its two hand-written mark input rules, its own
  // bullet-list input rule, and `prosemirror-inputrules`. Measured 1,703
  // bytes gzip (own chunk, no shared chunk of its own) immediately after
  // landing.
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
  // Measured 13,586 bytes gzip (own chunk + 3 shared).
  "src/pages/settings-page.tsx": { ceilingBytes: 17_600, baselineBytes: 13_586 },
  // Todo — `/todo/inbox` (issue #168), `/todo/today` (issue #169) and,
  // since issue #171, `/todo/projects` and `/todo/projects/:projectId`,
  // since `App.tsx` points four `<Route>` elements at the one lazily-
  // imported `TodoPage`, switched by its own `view` prop, rather than a
  // second `import("@/pages/...")` per view. Re-measured 2026-09-02
  // against a clean `vite build --mode android`, immediately after #171's
  // own Projects/Sections UI landed (task-tree.tsx, task-list.tsx,
  // project-view.tsx, projects-view.tsx, use-projects.ts — all new,
  // first-party weight, not a shared dependency moving in): 43,623 grew to
  // 51,254 bytes gzip (own chunk + 7 shared), a real ~17% increase this
  // ticket's own brief predicted ("Todo's route budget will grow").
  // `ceilingBytes` raised to keep the same ~30% headroom over that fresh
  // baseline every other budget in this table carries, not because the
  // build actually failed against the old 56,700 ceiling (it still had
  // 5,446 bytes of headroom left) — the point is a ceiling that reflects
  // what this route honestly costs now, not one quietly eaten down to a
  // sliver by an increase nobody recorded.
  //
  // Most of the *shared* portion, not Todo's own code, is still
  // `date-picker-sheet` (~20.8 KB, react-day-picker) — issue #169's
  // schedule sheet reusing the app's existing date UI rather than
  // building a second one, unchanged by this ticket.
  //
  // Re-measured 2026-09-03 against a clean `vite build --mode android`,
  // immediately after issue #178's Task detail view landed
  // (task-detail-view.tsx, task-command-menu.tsx, task-detail-route.ts,
  // task-priority-colors.ts — all new, first-party weight, plus this
  // route's first use of Radix's `DropdownMenu` primitive, which nothing
  // in Todo needed before the full command set): 51,254 grew to 67,406
  // bytes gzip (own chunk + 7 shared). `ceilingBytes` raised to keep the
  // same ~30% headroom over that fresh baseline every other budget in
  // this table carries — the old 67,000 ceiling would have failed this
  // build by 406 bytes, and the point of a ceiling is to reflect what a
  // route honestly costs now, not to be quietly eaten down to nothing by
  // an increase this ticket's own report already names as expected
  // ("Todo's route budget will grow," the identical prediction #171's own
  // comment above already made good on once).
  // Re-measured 2026-09-10 immediately after issue #225's inline rename
  // and detail-title editing landed: 81,251 (this ticket's own GitHub
  // comment, taken right after #223) grew to 82,590 bytes gzip — +1,339
  // bytes, from the activation state/`<Suspense>` wiring `task-row-
  // content.tsx` and `task-detail-view.tsx` gained, not from ProseMirror
  // itself (`task-title-editor.tsx`'s own CHUNK_BUDGETS entry above shows
  // that landed in its own 1,088-byte lazy chunk, uncounted here). Left
  // at 87,600/67,406 rather than bumped: the ceiling still holds with
  // 5,010 bytes of headroom, and `baselineBytes` here is stale by a wider
  // margin than just this ticket accounts for (a prior re-measurement this
  // table records elsewhere was never carried into this field) — a
  // correction belongs to whichever ticket next has reason to touch this
  // budget deliberately, not a side effect of landing #225.
  //
  // Re-measured 2026-09-10, later the same day: a clean build measured
  // 86,949 gzip bytes against the unchanged 87,600 ceiling — 651 bytes of
  // headroom, with issue #228's keyboard layer and issue #229's detail
  // modal/project/label/filter management both still due to land here.
  // That is this ticket's own starting point, not new growth this table
  // failed to record earlier — see the immediately preceding entry's own
  // "stale by a wider margin" note.
  //
  // This ticket moved `TaskDetailView` and `TaskScheduleSheet` (plus,
  // through it, `TaskSchedulePopover`) behind lazy boundaries —
  // `lazy-task-detail-view.ts`/`lazy-task-schedule-sheet.ts`'s own header
  // comments have the full reasoning — dropping this route to 81,021
  // gzip bytes, 6,579 bytes of headroom against the same, still-unchanged
  // 87,600 ceiling. `ceilingBytes` is deliberately NOT tightened down
  // toward this new, lower baseline the way a fresh route's ceiling
  // normally would be: the entire point of this ticket was reclaiming
  // room for #228/#229 to spend, not handing it straight back by shrinking
  // the ceiling to match. Whether 6,579 bytes is enough for both of those
  // tickets is not yet knowable — neither has been built — so this is
  // reported rather than guessed at (this ticket's own report).
  //
  // Issue #229's own second half (Projects/Sections/Labels/Filters
  // management — this ticket's own brief) started from 82,948 gzip bytes
  // against this same 87,600 ceiling (issue #228's keyboard layer having
  // landed since this entry's own 81,021 baseline above, another instance
  // of the "stale by a wider margin" gap the entries above already
  // name — never carried forward at the time). This ticket landed a
  // Project colour select and delete confirmation (project-view.tsx), a
  // Labels section plus a "Manage Labels" link (filters-view.tsx), and
  // the new `labels-view.tsx` screen (`/todo/labels`) with its own
  // inline create/rename/recolour/delete, statically imported like every
  // other Todo view rather than split behind a lazy boundary: measured
  // 83,540 gzip bytes against the unchanged ceiling — +592 bytes over
  // that 82,948 starting point, still 4,060 bytes of headroom to spare,
  // so no lazy split was needed for this ticket's own surface after all.
  //
  // Issues #247-#254 (the Todoist-parity programme) spent the rest of that
  // headroom and 485 bytes more: measured 88,085 gzip against the 87,600
  // ceiling, +4,545 over the 83,540 baseline above. **Ceiling raised to
  // 89,000 deliberately, and the reason matters more than the number.**
  //
  // Of that, this route's OWN chunk is 26,891; the rest is shared chunks
  // this walk reaches, and the growth is spread across the programme
  // rather than attributable to one ticket. **No bytes are duplicated in
  // the artifact** — checked against `dist/*/.vite/manifest.json`, not
  // assumed: there is exactly one `calendar-*.js` and one
  // `todo-quick-add-recognition-*.js` emitted, and both are reached by
  // this route and by `task-detail-view.tsx` below, so this table bills
  // each of them to both entries by the deliberate double-count rule
  // `measureChunk`'s own comment states.
  //
  // **A lazy boundary was considered for the scheduler and rejected on
  // its merits.** `lazy-task-schedule-sheet.ts` works because
  // `todo-page.tsx` gates it on `schedulingTask !== null` — nothing
  // renders until a reader asks to schedule. Issue #253's popover has no
  // such gate: it renders on every row, because `TaskSchedulePopover`
  // takes that row's Date button as its `trigger` prop. Putting it behind
  // `lazy()` takes the trigger down with it until the chunk resolves, and
  // substituting a placeholder trigger breaks exactly the `asChild` ref
  // anchoring #253 exists to fix — anchoring that was verified by
  // measuring trigger and popover rects in a real browser
  // (`meologue-reference/todoist/verification-2026-09-11.md`), and which no
  // test in this repo can see. Trading a measured, verified behaviour for
  // 485 bytes is a bad trade; paying the bytes and recording why is not.
  //
  // If this route needs reclaiming, the candidate is a shared boundary
  // owning the whole scheduler family INCLUDING its trigger, not another
  // per-component `lazy()`.
  //
  // **PR #259: 92,478 gzip (own chunk + 21 shared), up from 88,085.** The
  // dominant term is not this route's own code but the shared
  // `todo-quick-add-recognition-*.js` chunk's +8,708 (`SCHED-14`'s Repeat
  // menu, `SCHED-11`'s Time dialog) — see `task-detail-view.tsx` above,
  // which failed the same build off the same chunk. This route's own 20,438
  // additionally carries the strings for the in-list Quick Add's footer
  // ("Remove date", "More actions": `NAV-12`, `QA-15`) and the structural
  // wording `NAV-06`/`STR-06` added ("My Filters", "Delete filter?").
  //
  // Ceiling 89,000 -> 99,000, still ~7% headroom rather than the ~30% this
  // section's header describes, because Todo is the route where growth needs
  // to stay deliberate: the previous ceiling left 915 bytes and that is what
  // made this failure visible at all.
  //
  // **Issue #288's bundle follow-up.** This route's own `ActivityFeed`
  // import (its own "the view across everything," issue #184's
  // `backgroundView.view === "activity"` branch) went lazy alongside
  // `task-detail-view.tsx`'s — that entry's own comment above has why
  // both call sites had to move together. Measured at 97,824 gzip (own
  // chunk + 19 shared) immediately before this ticket, already above the
  // 92,478 last recorded here (drift from intervening Todo work this
  // ticket did not audit); 96,130 gzip (own chunk + 22 shared)
  // immediately after — a real 1,694-byte drop from `ActivityFeed` going
  // lazy, recorded as the new baseline, not squared against the older,
  // already-stale 92,478.
  // Re-measured 2026-09-17 after ADR 0084 added the Browse hub to this
  // route: 96,130 -> 96,709 gzip (+579 bytes for `browse-view.tsx`). The
  // ceiling was NOT raised then — this route ran on ~3% headroom rather
  // than the ~30% the rest of this table assumes, so the next Todo view to
  // land here would trip it — and issue #358 is exactly that prediction
  // coming true, measured at 98,963 gzip immediately before this ticket's
  // own work (three intervening tickets' drift this table never recorded:
  // one-palette's token/font changes, the Composer's day-jump controls, and
  // the single-completion-toast rework), 37 bytes of headroom against the
  // unchanged 99,000 ceiling.
  //
  // Issue #358 (ROW-14, parity-ledger.md): meologue's own "Completed tasks"
  // display setting, off by default — hidden entirely off, relocated below
  // the active list with a Load-more control on. This is not a candidate
  // for a lazy split the way `task-detail-view.tsx`/`task-schedule-
  // sheet.tsx` above were: those render only once a reader asks for a
  // specific Task's detail or schedule, gated on `openTask`/
  // `schedulingTask` being non-null, so a Suspense boundary genuinely
  // removes bytes from the common case. Completed-Task display is core
  // list rendering — `task-list.tsx`/`task-tree.tsx` render on every visit
  // to Inbox, Todo's own default view, with no gate to hang a lazy
  // boundary on — so `use-completed-tasks-page.ts`,
  // `completed-tasks-load-more.tsx` and `completed-tasks-page-size.ts`
  // (all new, small, first-party weight, shared by `task-tree.tsx`,
  // `filter-view.tsx` and `task-search-page.tsx`) would ship on this route
  // eagerly regardless of where they lived; a `lazy()` boundary here would
  // add an `import()` round trip to Inbox's own first paint for a handful
  // of bytes, not remove them from the download. Measured 99,280 gzip
  // immediately after landing — +317 bytes over the 98,963 this ticket
  // started from, entirely first-party (the three modules above, plus the
  // new `SettingsSection` row wired through `todo-page.tsx`'s own
  // `FilterView` call site).
  //
  // Re-baselined rather than split, per this file's own stated preference
  // order when no honest split exists. `ceilingBytes` keeps the identical
  // 37-byte absolute headroom the ceiling carried over this ticket's own
  // starting measurement (99,000 - 98,963), rather than resetting to this
  // section's ~30% norm: this route has run on a deliberately thin margin
  // since PR #259 (the entry immediately above), and widening it now would
  // hide the next regression the same way the last three tickets' silent
  // drift already did.
  "src/pages/todo-page.tsx": { ceilingBytes: 99_317, baselineBytes: 99_280 },
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
