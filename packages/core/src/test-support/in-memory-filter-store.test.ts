import { describe } from "vitest";
import { filterStoreContract } from "./filter-store-contract";
import { InMemoryFilterStore } from "./in-memory-filter-store";

describe("InMemoryFilterStore", () => {
  filterStoreContract(() => new InMemoryFilterStore());
});
