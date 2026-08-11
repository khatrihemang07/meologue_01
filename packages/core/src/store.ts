import type { Entry } from "./types";

export interface EntryStore {
  list(): Promise<Entry[]>;
  upsert(entries: Entry[]): Promise<void>;
  pending(): Promise<Entry[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
}
