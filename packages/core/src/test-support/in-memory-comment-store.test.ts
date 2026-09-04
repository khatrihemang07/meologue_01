import { describe } from "vitest";
import { commentStoreContract } from "./comment-store-contract";
import { InMemoryCommentStore } from "./in-memory-comment-store";

describe("InMemoryCommentStore", () => {
  commentStoreContract(() => new InMemoryCommentStore());
});
