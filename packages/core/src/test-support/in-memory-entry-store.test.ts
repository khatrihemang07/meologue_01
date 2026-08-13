import { describe } from "vitest";
import { entryStoreContract } from "./entry-store-contract";
import { InMemoryEntryStore } from "./in-memory-entry-store";

describe("InMemoryEntryStore", () => {
  entryStoreContract(() => new InMemoryEntryStore());
});
