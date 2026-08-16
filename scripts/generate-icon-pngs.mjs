#!/usr/bin/env node
// Rasterizes docs/brand/icon.svg into every derived PNG the icon pipeline
// needs, plus the templated favicon.svg. Invoked by generate-icons.sh — see
// that script for the platform-specific steps (cargo tauri icon,
// @capacitor/assets) that consume this script's output.
//
// docs/brand/icon.svg carries only the white glyph on transparency (a single
// heavy stroke with round caps/joins). Every render here composites that
// same glyph onto a background appropriate to where it's going: this file is
// the only place the glyph's proportions and scale live, so every icon in
// the repo is a variation of one drawing.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const NEAR_BLACK = "#18181B";
const GLYPH_PATH_D = "M69 22 L69 60 L31 60 M49 42 L31 60 L49 78";
const GLYPH_STROKE_WIDTH = 16; // in the glyph's own 0-100 unit space

// The glyph's own bounding box (path coords ± half the stroke width, plus
// round-cap radius) sits at roughly x:[23,77] y:[14,86] in the 0-100 unit
// space it's authored in — a diagonal of ~90 units out of the 100-unit box.
// `scaleFor(safeZonePercent)` returns the composite scale (fraction of the
// full canvas) that keeps that diagonal inside a centered circle of the
// given percent of the canvas, so callers can reason in terms of the safe
// zones platforms actually document (Android's 61%, PWA maskable's 80%)
// rather than picking scale numbers by feel.
const GLYPH_DIAGONAL_FRACTION = 90 / 100;
function scaleFor(safeZonePercent) {
  return safeZonePercent / 100 / GLYPH_DIAGONAL_FRACTION;
}

/** Builds a self-contained SVG string: an optional background rect (skip for
 * transparent canvases) plus the glyph, scaled to `glyphScale` of the full
 * canvas and centered. */
function composeSvg({ size, background, cornerRadiusPercent = 0, glyphScale }) {
  const bg = background
    ? `<rect width="${size}" height="${size}" rx="${(cornerRadiusPercent * size) / 100}" fill="${background}"/>`
    : "";
  const glyph = glyphScale
    ? `<g transform="translate(${size / 2} ${size / 2}) scale(${(glyphScale * size) / 100}) translate(-50 -50)">
        <path d="${GLYPH_PATH_D}" fill="none" stroke="#FFFFFF" stroke-width="${GLYPH_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}${glyph}</svg>`;
}

// --- favicon-only glyph -----------------------------------------------
//
// The favicon is its own composition, not a shrunk copy of the macOS tile.
// At 16px — the size browser tabs actually render — the source glyph's
// three thin stroked segments (shaft, then a two-line chevron) sit close
// enough together that downsampling merges them into a smear with no
// readable silhouette; that held even after cranking glyphScale toward the
// full canvas and thickening the shared stroke width, because the two
// chevron strokes plus the gap between them are what collapses, not the
// glyph's overall size. Filling the canvas alone does not fix a shape whose
// negative space is itself sub-pixel at 16px.
//
// The fix: replace the chevron with a single filled triangle (solid mass,
// no interior gap) fused to the end of the shaft. Same "down, then left,
// then an arrowhead" silhouette as the main glyph, but it survives 16px
// downsampling because there's no thin negative space left to lose. This
// shape is used for the favicon only — every other render keeps the
// stroked glyph from docs/brand/icon.svg.
const FAVICON_SHAFT_TOP = 14; // where the vertical stroke starts (0-100 space)
const FAVICON_SHAFT_STROKE_WIDTH = 14;
const FAVICON_BEND_Y = 56; // where the shaft turns left into the arrowhead
const FAVICON_ARROWHEAD_BASE_X = 56; // shaft end / triangle base x
const FAVICON_ARROWHEAD_TIP_X = 14; // triangle tip x — near the left edge
const FAVICON_ARROWHEAD_HALF_HEIGHT = 26;
const FAVICON_SHAFT_X = 70;

function composeFaviconSvg({ size, background, cornerRadiusPercent = 0 }) {
  const s = size / 100;
  const bg = background
    ? `<rect width="${size}" height="${size}" rx="${(cornerRadiusPercent * size) / 100}" fill="${background}"/>`
    : "";
  const shaft = `<path d="M${FAVICON_SHAFT_X * s} ${FAVICON_SHAFT_TOP * s} L${FAVICON_SHAFT_X * s} ${FAVICON_BEND_Y * s} L${FAVICON_ARROWHEAD_BASE_X * s} ${FAVICON_BEND_Y * s}" fill="none" stroke="#FFFFFF" stroke-width="${FAVICON_SHAFT_STROKE_WIDTH * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const triPoints = [
    `${FAVICON_ARROWHEAD_BASE_X * s},${(FAVICON_BEND_Y - FAVICON_ARROWHEAD_HALF_HEIGHT) * s}`,
    `${FAVICON_ARROWHEAD_TIP_X * s},${FAVICON_BEND_Y * s}`,
    `${FAVICON_ARROWHEAD_BASE_X * s},${(FAVICON_BEND_Y + FAVICON_ARROWHEAD_HALF_HEIGHT) * s}`,
  ].join(" ");
  const arrowhead = `<polygon points="${triPoints}" fill="#FFFFFF"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}${shaft}${arrowhead}</svg>`;
}

async function renderPng(svg, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  // No `density` override: composeSvg() already sets explicit pixel width/
  // height on the <svg> root, and sharp's `density` scales *on top* of that
  // (it's meant for SVGs with only a viewBox, no absolute size) — passing it
  // here silently blew a 1024px canvas up to ~4267px.
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log(`wrote ${outPath.replace(`${ROOT}/`, "")}`);
}

function writeSvgFile(svg, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg);
  console.log(`wrote ${outPath.replace(`${ROOT}/`, "")}`);
}

async function main() {
  // Verify the source file is what we think it is (fail loud if someone
  // hand-edits the glyph path without updating this script's copy).
  const source = readFileSync(join(ROOT, "docs/brand/icon.svg"), "utf8");
  if (!source.includes(GLYPH_PATH_D)) {
    throw new Error(
      "docs/brand/icon.svg's glyph path no longer matches generate-icon-pngs.mjs's GLYPH_PATH_D — update the constant to match the source of truth.",
    );
  }

  // --- docs/brand: the two canonical 1024 renders described by the ticket ---
  await renderPng(
    composeSvg({
      size: 1024,
      background: NEAR_BLACK,
      cornerRadiusPercent: 22,
      glyphScale: scaleFor(62),
    }),
    join(ROOT, "docs/brand/tile.png"),
  );
  await renderPng(
    composeSvg({ size: 1024, background: null, glyphScale: scaleFor(58) }),
    join(ROOT, "docs/brand/foreground.png"),
  );

  // --- apps/web/assets: working input for @capacitor/assets (custom mode) ---
  const capAssets = join(ROOT, "apps/web/assets");
  await renderPng(
    composeSvg({
      size: 1024,
      background: NEAR_BLACK,
      cornerRadiusPercent: 0,
      glyphScale: scaleFor(62),
    }),
    join(capAssets, "icon-only.png"),
  );
  await renderPng(
    composeSvg({ size: 1024, background: null, glyphScale: scaleFor(58) }),
    join(capAssets, "icon-foreground.png"),
  );
  await renderPng(
    composeSvg({ size: 1024, background: NEAR_BLACK, cornerRadiusPercent: 0, glyphScale: null }),
    join(capAssets, "icon-background.png"),
  );
  await renderPng(
    composeSvg({
      size: 2732,
      background: NEAR_BLACK,
      cornerRadiusPercent: 0,
      glyphScale: scaleFor(30),
    }),
    join(capAssets, "splash.png"),
  );

  // --- apps/web/public: PWA icons + favicon ---
  const publicDir = join(ROOT, "apps/web/public");
  await renderPng(
    composeSvg({
      size: 192,
      background: NEAR_BLACK,
      cornerRadiusPercent: 0,
      glyphScale: scaleFor(62),
    }),
    join(publicDir, "icon-192.png"),
  );
  await renderPng(
    composeSvg({
      size: 512,
      background: NEAR_BLACK,
      cornerRadiusPercent: 0,
      glyphScale: scaleFor(62),
    }),
    join(publicDir, "icon-512.png"),
  );
  await renderPng(
    composeSvg({
      size: 512,
      background: NEAR_BLACK,
      cornerRadiusPercent: 0,
      glyphScale: scaleFor(80),
    }),
    join(publicDir, "icon-512-maskable.png"),
  );

  // No corner-radius inset here (unlike the macOS tile): the favicon canvas
  // is tiny, so every percent of padding is pixels the glyph doesn't get.
  // Browser tab chrome already clips/masks the favicon itself.
  writeSvgFile(
    composeFaviconSvg({
      size: 100,
      background: NEAR_BLACK,
      cornerRadiusPercent: 0,
    }),
    join(publicDir, "favicon.svg"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
