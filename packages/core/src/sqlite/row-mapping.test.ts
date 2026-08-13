import { describe, expect, it } from "vitest";
import { toPositionalRow, toPositionalRows } from "./row-mapping";

describe("toPositionalRow", () => {
  it("converts a column-named row into values ordered by insertion order", () => {
    expect(toPositionalRow({ id: "e1", body: "hello", seq: 3 })).toEqual(["e1", "hello", 3]);
  });

  it("throws rather than silently misplacing a value for a non-object row", () => {
    expect(() => toPositionalRow("not a row")).toThrow(/expected a column-named object/);
    expect(() => toPositionalRow(null)).toThrow(/expected a column-named object/);
  });

  it("throws for an array, which would otherwise pass through unmapped", () => {
    expect(() => toPositionalRow(["e1", "hello"])).toThrow(/expected a column-named object/);
  });
});

describe("toPositionalRows", () => {
  it("maps every row in a result set", () => {
    expect(toPositionalRows([{ a: 1 }, { a: 2 }])).toEqual([[1], [2]]);
  });
});
