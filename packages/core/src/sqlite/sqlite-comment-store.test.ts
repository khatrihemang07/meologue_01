import { describe } from "vitest";
import { commentStoreContract } from "../test-support/comment-store-contract";
import { NodeSqliteDriver } from "./node-driver";
import { open } from "./open";

describe("SqliteCommentStore", () => {
  commentStoreContract(async () => {
    const { commentStore } = await open(new NodeSqliteDriver());
    return commentStore;
  });
});
