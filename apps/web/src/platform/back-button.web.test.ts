import { describe, expect, it } from "vitest";
import { subscribeToBackButton } from "./back-button.web";

describe("back-button.web", () => {
  it("is a no-op: subscribing does nothing observable and returns an inert unsubscribe", () => {
    const unsubscribe = subscribeToBackButton(() => true);

    expect(() => unsubscribe()).not.toThrow();
  });
});
