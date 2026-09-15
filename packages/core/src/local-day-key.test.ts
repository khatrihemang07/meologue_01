import { describe, expect, it } from "vitest";
import {
  isLocalDayKey,
  type LocalDayKey,
  mustParseLocalDayKey,
  parseLocalDayKey,
} from "./local-day-key";
import type { TaskStore } from "./task-store";

describe("isLocalDayKey/parseLocalDayKey/mustParseLocalDayKey", () => {
  it("accepts a floating YYYY-MM-DD day key", () => {
    expect(isLocalDayKey("2026-09-15")).toBe(true);
    expect(parseLocalDayKey("2026-09-15")).toBe("2026-09-15");
    expect(mustParseLocalDayKey("2026-09-15")).toBe("2026-09-15");
  });

  it("rejects a UTC instant — the exact shape every one of the four historical bugs handed a `today` parameter", () => {
    const instant = "2026-09-14T18:46:18.000Z"; // issue #290's own measured 00:16 IST example
    expect(isLocalDayKey(instant)).toBe(false);
    expect(parseLocalDayKey(instant)).toBeNull();
    expect(() => mustParseLocalDayKey(instant)).toThrow();
  });

  it("rejects a malformed string outright, rather than throwing only on the instant shape", () => {
    expect(parseLocalDayKey("not a day")).toBeNull();
    expect(() => mustParseLocalDayKey("")).toThrow();
  });
});

/**
 * The mutation test issue #300 asks for: not "does `LocalDayKey` exist,"
 * but "does removing the brand from `TaskStore`'s `today` parameters make
 * this fail." It does — verified by hand for this change (see the commit
 * body): reverting `setDateString`/`advanceRecurring`/`postpone`'s `today`
 * from `LocalDayKey` back to `string` turns every `@ts-expect-error` below
 * into an "unused '@ts-expect-error' directive" error under `tsc -b
 * --noEmit`, so the suite stops being green rather than staying green
 * around a brand that no longer does anything — the exact failure mode a
 * test that "proves nothing" would hide.
 *
 * `it.skip` rather than `it`: every line below is deliberately
 * ill-typed application code, meant to be checked by `tsc -b --noEmit`
 * (`packages/core`'s own `tsconfig.json` includes this whole `src`
 * directory, test files included) and never actually executed — `store`
 * below is cast from `{}`, so calling into it for real would throw. Skip
 * keeps vitest from ever invoking the callback while still parsing and
 * type-checking its contents, exactly like the rest of this file.
 */
it.skip("compile-only: TaskStore's `today` parameters reject a raw string or a UTC instant (issue #300)", () => {
  const store = {} as TaskStore;
  const rawToday: string = "2026-09-15";
  const utcInstant: string = new Date().toISOString();
  const validDay: LocalDayKey = mustParseLocalDayKey("2026-09-15");

  // The plain `string` that used to satisfy every one of these — no
  // longer does, even when it's shaped exactly like a valid day key.
  // @ts-expect-error — `postpone`'s `today` requires LocalDayKey, not a bare string.
  store.postpone("task-1", rawToday);

  // The literal historical bug (#290, #296): `new Date().toISOString()`
  // handed to a parameter that meant a floating local day.
  // @ts-expect-error — postpone: a UTC instant is not a LocalDayKey.
  store.postpone("task-1", utcInstant);
  // @ts-expect-error — setDateString: the identical #296 shape.
  store.setDateString("task-1", "every day", utcInstant);
  // @ts-expect-error — advanceRecurring: the identical #290 shape.
  store.advanceRecurring("task-1", utcInstant, utcInstant);

  // advanceRecurring's own "sharpest illustration" (issue #300's own
  // wording): `completedAt` and `today` sit adjacent, both used to be
  // `string`, and swapping them compiled. Put the *valid* day key in
  // `completedAt`'s position (still compiles — that side stays an
  // unbranded `string`, issue #300's own documented asymmetric choice)
  // and the *instant* in `today`'s position — the actual swap a caller
  // could make by transposing the last two arguments.
  // @ts-expect-error — the instant, swapped into `today`'s slot, is still not a LocalDayKey.
  store.advanceRecurring("task-1", validDay, utcInstant);

  // The one legitimate producer — no cast, no `@ts-expect-error` — compiles.
  void store.postpone("task-1", validDay);
});
