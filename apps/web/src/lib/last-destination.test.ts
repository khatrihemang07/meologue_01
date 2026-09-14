import { afterEach, describe, expect, it } from "vitest";
import {
  clearLastDestination,
  readLastDestination,
  writeLastDestination,
} from "./last-destination";

describe("last-destination", () => {
  // The module holds one shared, module-level variable (deliberately not
  // storage — see this module's own doc comment), so a later test's read
  // must not see an earlier test's write.
  afterEach(() => {
    clearLastDestination();
  });

  it("returns null when nothing has been recorded yet", () => {
    expect(readLastDestination()).toBeNull();
  });

  it("returns what was last written", () => {
    writeLastDestination("/composer");
    expect(readLastDestination()).toBe("/composer");
  });

  it("a later write replaces the earlier one, rather than accumulating", () => {
    writeLastDestination("/composer");
    writeLastDestination("/todo");
    expect(readLastDestination()).toBe("/todo");
  });

  it("clear forgets the remembered Destination", () => {
    writeLastDestination("/composer");
    clearLastDestination();
    expect(readLastDestination()).toBeNull();
  });

  it("clear is a no-op when nothing was remembered", () => {
    expect(() => clearLastDestination()).not.toThrow();
    expect(readLastDestination()).toBeNull();
  });
});
