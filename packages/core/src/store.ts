import type { Entry } from "./types";

export interface EntryStore {
  list(): Promise<Entry[]>;
  upsert(entries: Entry[]): Promise<void>;
  pending(): Promise<Entry[]>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  /**
   * Entries whose body contains a word starting with `query`, in the same
   * order as list() (ADR 0014). Matching is prefix-based and the query
   * text is always taken literally, never as query syntax. An empty or
   * whitespace-only query matches nothing.
   */
  search(query: string): Promise<Entry[]>;
}
