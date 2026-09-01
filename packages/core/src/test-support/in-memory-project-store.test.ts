import { describe } from "vitest";
import { InMemoryProjectStore } from "./in-memory-project-store";
import { InMemoryTaskStore } from "./in-memory-task-store";
import { projectStoreContract } from "./project-store-contract";

describe("InMemoryProjectStore", () => {
  projectStoreContract(() => {
    const taskStore = new InMemoryTaskStore();
    const projectStore = new InMemoryProjectStore(taskStore);
    return { projectStore, taskStore };
  });
});
