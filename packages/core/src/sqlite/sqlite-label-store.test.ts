import { describe } from "vitest";
import { labelStoreContract } from "../test-support/label-store-contract";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("SqliteLabelStore", () => {
  labelStoreContract(async () => {
    const { labelStore } = await open(new NodeSqliteDriver());
    return labelStore;
  });
});
