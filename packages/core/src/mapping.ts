import type { Entry } from "./types";
import type { WireEntryInput, WireEntryOutput } from "./wire";

export function toWireEntryInput(entry: Entry): WireEntryInput {
  return {
    id: entry.id,
    device_id: entry.deviceId,
    body: entry.body,
    created_at: entry.createdAt,
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
  };
}
