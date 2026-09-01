import { describe, expect, it, vi } from "vitest";
import { orderKeyBetween } from "../order-key";
import { task } from "../test-support/task-fixture";
import { taskStoreContract } from "../test-support/task-store-contract";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("SqliteTaskStore", () => {
  taskStoreContract(async () => {
    const { taskStore } = await open(new NodeSqliteDriver());
    return taskStore;
  });

  // SQLite-specific, on top of the shared contract's implementation-
  // agnostic "every sibling untouched" version of this same property
  // (../test-support/task-store-contract.ts): wraps the real driver in a
  // spy so this asserts the literal thing TaskStore.reorder's doc comment
  // promises — one row written — by counting statements, not just
  // inferring it from the result.
  it("reorder() issues exactly one write statement against `tasks`", async () => {
    const driver = new NodeSqliteDriver();
    const { taskStore } = await open(driver);
    await taskStore.upsert([
      task({ id: "a", orderKey: "a", seq: 1 }),
      task({ id: "b", orderKey: "b", seq: 1 }),
      task({ id: "c", orderKey: "c", seq: 1 }),
    ]);

    const executeSpy = vi.spyOn(driver, "execute");
    await taskStore.reorder("b", orderKeyBetween(null, "a"));

    const writesAgainstTasks = executeSpy.mock.calls.filter(
      ([sql, , method]) => method === "run" && /\bupdate\s+"tasks"/i.test(sql as string),
    );
    expect(writesAgainstTasks).toHaveLength(1);
  });
});
