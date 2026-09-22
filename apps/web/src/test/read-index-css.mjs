// A plain `.mjs` module, deliberately NOT `.ts` — `index.css.tokens.test.ts`
// (this directory's own sibling) needs `node:fs` to read the real
// stylesheet bytes rather than importing them (`index.css?raw` resolves to
// an empty string under vitest — `check-css-cascade.mjs`'s own header
// comment has the full story on why), and `tsconfig.app.json` (which
// covers every `.ts` file under `src/`, tests included) carries no `node`
// types to type-check that import against. Plain `.js`/`.mjs` files are
// invisible to `tsc -b` with `allowJs` unset (the same reason
// `check-css-cascade.mjs` itself lives outside the TS project entirely,
// in `scripts/`) — so this one file, alone, is where `node:fs` is safe to
// use from inside `src/`. `read-index-css.d.mts` (this file's own sibling)
// is what lets a `.ts` file import it at all despite that.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.css");

export function readIndexCss() {
  return readFileSync(INDEX_CSS_PATH, "utf8");
}
