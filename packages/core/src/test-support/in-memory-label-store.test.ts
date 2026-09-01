import { describe } from "vitest";
import { InMemoryLabelStore } from "./in-memory-label-store";
import { labelStoreContract } from "./label-store-contract";

describe("InMemoryLabelStore", () => {
  labelStoreContract(() => new InMemoryLabelStore());
});
