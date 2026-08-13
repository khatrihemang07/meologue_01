import { describe } from "vitest";
import { entryStoreContract } from "../test-support/entry-store-contract";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("SqliteEntryStore", () => {
  entryStoreContract(async () => {
    const { store } = await open(new NodeSqliteDriver());
    return store;
  });
});
