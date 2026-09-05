/**
 * See load-file.web.ts's LoadFileResult doc comment for why this type is
 * declared independently in each load-file.<target>.ts elsewhere; Android
 * is the exception here, for the same reason save-file.sandbox.ts's own
 * header comment gives for its own type re-export — see this file's
 * `loadFile` doc comment just below for why Android's *implementation*,
 * not just its type, has nothing of its own to diverge.
 */
export type { LoadFileResult } from "./load-file.web";

/**
 * Android's load-file seam (issue #197). Reuses the web implementation
 * unchanged, on purpose, rather than a picker plugin: Capacitor's
 * `BridgeWebChromeClient` implements Android's `onShowFileChooser` for the
 * WebView it hosts, so a plain `<input type="file">` — the exact element
 * load-file.web.ts already creates — opens the system document picker the
 * same way it would in a browser tab. Reusing that means Restore's file
 * picker needs no new native dependency, no new permission, and no
 * Capacitor plugin beyond what `save-file.android.ts` already pulls in for
 * Backup's own share sheet.
 *
 * This is a "try the obvious thing first" decision (this ticket's own
 * brief, #197), not yet a load-bearing claim verified against every
 * Android WebView version this app ships to — if a real device turns up a
 * case where the system picker doesn't appear, or `accept=".zip"` filters
 * more aggressively than intended, or the resulting `File` object's
 * `arrayBuffer()` behaves differently under Capacitor's `http://localhost`
 * origin than it does in a real browser tab, replacing this file's content
 * with a dedicated picker plugin (`@capawesome/capacitor-file-picker` is
 * the obvious candidate) is a self-contained change — nothing else in this
 * seam, or in load-file.web.ts, needs to move for that swap to happen.
 * See this ticket's own report for whether that swap turned out to be
 * necessary.
 */
export { loadFile } from "./load-file.web";
