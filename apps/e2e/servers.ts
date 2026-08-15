// Addresses of the two Servers the e2e suite boots (see
// scripts/e2e-server.sh and scripts/e2e-server-b.sh). Shared between
// playwright.config.ts (webServer entries, default storageState) and the
// specs that need a second, fully independent Server (multi-server.spec.ts)
// — one place these ports are named, rather than one per file.
export const SERVER_A_PORT = 41217;
export const SERVER_B_PORT = 41227;
export const SERVER_A_URL = `http://localhost:${SERVER_A_PORT}`;
export const SERVER_B_URL = `http://localhost:${SERVER_B_PORT}`;
