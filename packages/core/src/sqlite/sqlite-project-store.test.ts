import { describe, expect, it, vi } from "vitest";
import { orderKeyBetween } from "../order-key";
import { project, section } from "../test-support/project-fixture";
import { projectStoreContract } from "../test-support/project-store-contract";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("SqliteProjectStore", () => {
  projectStoreContract(async () => {
    const { projectStore, taskStore } = await open(new NodeSqliteDriver());
    return { projectStore, taskStore };
  });

  // ADR 0050's central claim is that a drag writes exactly *one* row —
  // that is the whole reason fractional indexing was chosen over integer
  // positions, and it is the property that makes two Devices reordering
  // different items converge. `sqlite-task-store.test.ts` proves it for
  // `TaskStore.reorder` by counting statements through a driver spy;
  // Projects and Sections reuse the same ordering primitive and owe the
  // same guarantee, so they get the same proof rather than inheriting it
  // by resemblance. The contract suite alone cannot show this: it asserts
  // the resulting *order*, which an implementation that rewrote every
  // sibling would also satisfy.
  it("reorderProject() issues exactly one write statement against `projects`", async () => {
    const driver = new NodeSqliteDriver();
    const { projectStore } = await open(driver);
    await projectStore.upsertProjects([
      project({ id: "a", orderKey: "a", seq: 1 }),
      project({ id: "b", orderKey: "b", seq: 1 }),
      project({ id: "c", orderKey: "c", seq: 1 }),
    ]);

    const executeSpy = vi.spyOn(driver, "execute");
    await projectStore.reorderProject("b", orderKeyBetween(null, "a"));

    const writes = executeSpy.mock.calls.filter(
      ([sql, , method]) => method === "run" && /\bupdate\s+"projects"/i.test(sql as string),
    );
    expect(writes).toHaveLength(1);
  });

  it("reorderSection() issues exactly one write statement against `sections`", async () => {
    const driver = new NodeSqliteDriver();
    const { projectStore } = await open(driver);
    await projectStore.upsertProjects([project({ id: "p", orderKey: "a", seq: 1 })]);
    await projectStore.addSection(section({ id: "s1", projectId: "p", orderKey: "a" }));
    await projectStore.addSection(section({ id: "s2", projectId: "p", orderKey: "b" }));

    const executeSpy = vi.spyOn(driver, "execute");
    await projectStore.reorderSection("s2", orderKeyBetween(null, "a"));

    const writes = executeSpy.mock.calls.filter(
      ([sql, , method]) => method === "run" && /\bupdate\s+"sections"/i.test(sql as string),
    );
    expect(writes).toHaveLength(1);
  });
});
