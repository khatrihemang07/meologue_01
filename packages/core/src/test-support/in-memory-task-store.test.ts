import { describe } from "vitest";
import { InMemoryTaskStore } from "./in-memory-task-store";
import { taskStoreContract } from "./task-store-contract";

describe("InMemoryTaskStore", () => {
  taskStoreContract(() => new InMemoryTaskStore());
});
