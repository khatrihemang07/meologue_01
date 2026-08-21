import type { Entry } from "./types";
import type { WireEntryInput, WireEntryOutput } from "./wire";

export function toWireEntryInput(entry: Entry): WireEntryInput {
  return {
    id: entry.id,
    device_id: entry.deviceId,
    body: entry.body,
    created_at: entry.createdAt,
    deleted_at: entry.deletedAt,
  };
}

export function fromWireEntryOutput(output: WireEntryOutput, syncedAt: string): Entry {
  return {
    id: output.id,
    deviceId: output.device_id,
    body: output.body,
    createdAt: output.created_at,
    seq: output.seq,
    syncedAt,
    // `deleted_at` is optional on the wire type (absent and null both mean
    // "not a tombstone") — normalise the absent case to null so Entry's
    // own deletedAt is never undefined (ADR 0028).
    deletedAt: output.deleted_at ?? null,
  };
}
