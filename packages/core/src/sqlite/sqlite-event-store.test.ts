import { describe } from "vitest";
import { eventStoreContract } from "../test-support/event-store-contract";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("SqliteEventStore", () => {
  eventStoreContract(async () => {
    const { eventStore } = await open(new NodeSqliteDriver());
    return eventStore;
  });
});
