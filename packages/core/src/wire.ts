import type { components } from "./generated/wire";

export type WireHealthResponse = components["schemas"]["HealthResponse"];
// Issue #133: which Server-backed Destinations this Server can actually
// serve, computed from the same `LlmConfig` that gates route registration
// (`server/src/health.rs`'s own doc comment). Optional on the wire — an
// older Server's `HealthResponse` simply omits it.
export type WireHealthCapabilities = components["schemas"]["HealthCapabilities"];
export type WireSyncRequest = components["schemas"]["SyncRequest"];
export type WireSyncResponse = components["schemas"]["SyncResponse"];
export type WireEntryInput = components["schemas"]["EntryInput"];
export type WireEntryOutput = components["schemas"]["EntryOutput"];
// Issue #172 / ADR 0051: Sync's second entity stream.
export type WireTaskInput = components["schemas"]["TaskInput"];
export type WireTaskOutput = components["schemas"]["TaskOutput"];
// Issue #182 / ADR 0051: four more entity streams.
export type WireProjectInput = components["schemas"]["ProjectInput"];
export type WireProjectOutput = components["schemas"]["ProjectOutput"];
export type WireSectionInput = components["schemas"]["SectionInput"];
export type WireSectionOutput = components["schemas"]["SectionOutput"];
export type WireLabelInput = components["schemas"]["LabelInput"];
export type WireLabelOutput = components["schemas"]["LabelOutput"];
export type WireCommentInput = components["schemas"]["CommentInput"];
export type WireCommentOutput = components["schemas"]["CommentOutput"];
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
