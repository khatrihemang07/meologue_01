// Addresses of the two Servers the e2e suite boots (see
// scripts/e2e-server.sh and scripts/e2e-server-b.sh). Shared between
// playwright.config.ts (webServer entries, default storageState) and the
// specs that need a second, fully independent Server (multi-server.spec.ts)
// — one place these ports are named, rather than one per file.
export const SERVER_A_PORT = 41217;
export const SERVER_B_PORT = 41227;
export const SERVER_A_URL = `http://localhost:${SERVER_A_PORT}`;
export const SERVER_B_URL = `http://localhost:${SERVER_B_PORT}`;

// The deterministic OpenAI-compatible stub (llm-stub.ts) that stands in for
// a real chat/embedding endpoint so `/v1/reflect` and `/v1/sessions` are
// registered on server A (issue #67) — see scripts/e2e-server.sh's
// MEOLOGUE_CHAT_*/MEOLOGUE_EMBED_* variables, which point at this address.
// Server B deliberately never learns this URL (reflection.spec.ts only ever
// asks through server A), so it keeps 404ing on those routes exactly as it
// did before this ticket.
export const LLM_STUB_PORT = 41237;
export const LLM_STUB_URL = `http://localhost:${LLM_STUB_PORT}`;
