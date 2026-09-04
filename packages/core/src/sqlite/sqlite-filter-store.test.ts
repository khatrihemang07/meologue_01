import { describe } from "vitest";
import { filterStoreContract } from "../test-support/filter-store-contract";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("SqliteFilterStore", () => {
  filterStoreContract(async () => {
    const { filterStore } = await open(new NodeSqliteDriver());
    return filterStore;
  });
});
