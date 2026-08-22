/**
 * The sandbox target is a browser build like web, just pointed at a
 * separate server and port so it can never collide with the user's own
 * data or bundle — so it reuses web's OPFS-backed sqlite-driver seam
 * unchanged rather than duplicating it.
 */
export { createDriver } from "./sqlite-driver.web";
