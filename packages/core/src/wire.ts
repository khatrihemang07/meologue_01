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
// Issue #184: Sync's seventh entity stream — landed additively inside
// protocol 6, no version bump (server/src/sync.rs's own PROTOCOL_VERSION
// doc comment).
export type WireEventInput = components["schemas"]["EventInput"];
export type WireEventOutput = components["schemas"]["EventOutput"];
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
// Issue #203: `GET`/`PATCH /v1/config` (server/src/settings.rs — issue #200
// built the route, #201 gave it three feature toggles, this ticket is its
// first client-side caller). `WireFeatureConfig`/`WireResolvedField`/
// `WireSource`/`WireTogglePatch` are the nested shapes `WireConfigResponse`/
// `WireConfigPatch` are built from; exported on their own rather than left
// inlined so `config-transport.ts` and the settings components can name
// one field's shape (e.g. a single toggle) without reaching through the
// whole response type.
export type WireConfigResponse = components["schemas"]["ConfigResponse"];
export type WireConfigPatch = components["schemas"]["ConfigPatch"];
export type WireResolvedField = components["schemas"]["ResolvedField"];
export type WireFeatureConfig = components["schemas"]["FeatureConfig"];
export type WireSource = components["schemas"]["Source"];
export type WireTogglePatch = components["schemas"]["TogglePatch"];
// Issue #198's own web-side follow-up: `GET /v1/backup` streams raw bytes
// (no schema to alias — apps/web's server-backup-transport.ts reads the
// response body directly), but `POST /v1/restore` and its rebuild
// follow-up both answer in JSON, so those two get the same hand-picked
// alias treatment every other JSON response on this page already does.
export type WireRestoreReport = components["schemas"]["RestoreReport"];
export type WireRebuildReport = components["schemas"]["RebuildReport"];
export type WireInstanceMode = components["schemas"]["InstanceMode"];
