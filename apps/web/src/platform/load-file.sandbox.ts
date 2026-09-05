/**
 * See load-file.web.ts's LoadFileResult doc comment for why this type is
 * declared independently in each load-file.<target>.ts elsewhere; sandbox
 * is the exception, since it is deliberately a browser build with no
 * behaviour of its own to diverge — it reuses web's type and
 * implementation directly, the same as save-file.sandbox.ts already does
 * for the save side.
 */
export type { LoadFileResult } from "./load-file.web";

/**
 * The sandbox target runs in a real browser tab (ticket 12's fourth
 * target), so it reuses the web implementation of the load-file seam
 * unchanged rather than duplicating it — mirrors save-file.sandbox.ts.
 */
export { loadFile } from "./load-file.web";
