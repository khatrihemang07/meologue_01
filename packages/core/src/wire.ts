import type { components } from "./generated/wire";

export type WireHealthResponse = components["schemas"]["HealthResponse"];
export type WireSyncRequest = components["schemas"]["SyncRequest"];
export type WireSyncResponse = components["schemas"]["SyncResponse"];
export type WireEntryInput = components["schemas"]["EntryInput"];
export type WireEntryOutput = components["schemas"]["EntryOutput"];
export type WireSessionResponse = components["schemas"]["SessionResponse"];
export type WireSessionTurn = components["schemas"]["SessionTurnRow"];
export type WireSessionSummary = components["schemas"]["SessionRow"];
export type WireReflectRequest = components["schemas"]["ReflectRequest"];
export type WireReflectResponse = components["schemas"]["ReflectResponse"];
export type WireDigestResponse = components["schemas"]["DigestResponse"];
export type WireDigest = components["schemas"]["Digest"];
// Issue #98: `GET /v1/models` (issue #96 built the route; this is its first
// client-side consumer).
export type WireModelsResponse = components["schemas"]["ModelsResponse"];
export type WireModelInfo = components["schemas"]["ModelInfo"];
