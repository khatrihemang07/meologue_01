/**
 * See save-file.web.ts's SaveFileOutcome doc comment for why this type is
 * declared independently in each save-file.<target>.ts elsewhere; sandbox is
 * the exception, since it is deliberately a browser build with no behaviour
 * of its own to diverge — it reuses web's type and implementation directly.
 */
export type { SaveFileOutcome } from "./save-file.web";

/**
 * The sandbox target runs in a real browser tab (ticket 12's fourth target),
 * so it reuses the web implementation of the save-file seam unchanged
 * rather than duplicating it.
 */
export { saveFile } from "./save-file.web";
