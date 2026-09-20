import { describe, expect, it } from "vitest";
import {
  isLocalDateTimeKey,
  isLocalDayKey,
  type LocalDateTimeKey,
  type LocalDayKey,
  mustParseLocalDateTimeKey,
  mustParseLocalDayKey,
  parseLocalDateTimeKey,
  parseLocalDayKey,
} from "./local-day-key";
import type { QuickAddOptions } from "./quick-add/types";
import type { RecurrenceReference } from "./recurrence/rule";
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

describe("isLocalDateTimeKey/parseLocalDateTimeKey/mustParseLocalDateTimeKey (issue #383)", () => {
  it("accepts a floating YYYY-MM-DDTHH:MM instant", () => {
    expect(isLocalDateTimeKey("2026-09-15T13:06")).toBe(true);
    expect(parseLocalDateTimeKey("2026-09-15T13:06")).toBe("2026-09-15T13:06");
    expect(mustParseLocalDateTimeKey("2026-09-15T13:06")).toBe("2026-09-15T13:06");
  });

  it("rejects a bare LocalDayKey — the exact regression #383 introduces: a day alone is no longer a valid `now`", () => {
    expect(isLocalDateTimeKey("2026-09-15")).toBe(false);
    expect(parseLocalDateTimeKey("2026-09-15")).toBeNull();
    expect(() => mustParseLocalDateTimeKey("2026-09-15")).toThrow();
  });

  it("rejects a UTC instant (seconds/milliseconds/Z) — HH:MM only, no more and no less", () => {
    const instant = "2026-09-14T18:46:18.000Z";
    expect(isLocalDateTimeKey(instant)).toBe(false);
    expect(parseLocalDateTimeKey(instant)).toBeNull();
    expect(() => mustParseLocalDateTimeKey(instant)).toThrow();
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

// Two plain accept-functions rather than typed `const` bindings, matching
// the `store.postpone(...)` call-site shape above: the bad literal is
// passed as an argument, so `@ts-expect-error` sits on the call rather
// than on an unused, ill-typed variable declaration.
function acceptReference(_reference: RecurrenceReference): void {}
function acceptOptions(_options: QuickAddOptions): void {}

/**
 * Issue #314's own mutation test — the one issue #300 left as tracked
 * follow-up rather than closing outright (see `./local-day-key.ts`'s own
 * header comment): `RecurrenceReference.now` and `QuickAddOptions.now`
 * were the two fields #300 could not brand while
 * `apps/web/src/components/todo/task-schedule-popover.tsx` was under
 * concurrent rework (#303) — their own construction sites live entirely
 * inside that one file. Verified by hand for this change (see the commit
 * body): reverting `RecurrenceReference.now` from `LocalDayKey` back to
 * `string` turns every `@ts-expect-error` below into an "unused
 * '@ts-expect-error' directive" error under `tsc -b --noEmit`, the same
 * mutation-verification #300's own test above records.
 *
 * `it.skip` for the identical reason as the block above: every line here
 * is deliberately ill-typed application code, checked by `tsc -b
 * --noEmit` and never actually executed.
 */
it.skip("compile-only: RecurrenceReference.now rejects a raw string or a UTC instant (issue #314)", () => {
  const rawToday: string = "2026-09-15";
  const utcInstant: string = new Date().toISOString();
  const validDay: LocalDayKey = mustParseLocalDayKey("2026-09-15");

  // The plain `string` that used to satisfy this field — no longer does,
  // even when it's shaped exactly like a valid day key.
  // @ts-expect-error — RecurrenceReference.now requires LocalDayKey, not a bare string.
  acceptReference({ dueDate: null, now: rawToday });

  // The literal historical shape (#290, #296): a UTC instant handed to a
  // parameter that means a floating local day.
  // @ts-expect-error — RecurrenceReference.now: a UTC instant is not a LocalDayKey.
  acceptReference({ dueDate: null, now: utcInstant });

  // `dueDate` stays an unbranded `string` on purpose (`./local-day-key.ts`'s
  // own "Why `completedAt`... is NOT branded" reasoning applies here too —
  // the asymmetric risk is identical) — only `now` rejects these.
  // @ts-expect-error — RecurrenceReference.now still requires LocalDayKey even when dueDate is a plain string.
  acceptReference({ dueDate: rawToday, now: rawToday });

  // The one legitimate producer — no cast, no `@ts-expect-error` — compiles.
  acceptReference({ dueDate: null, now: validDay });
});

/**
 * Issue #383's own mutation test, the `QuickAddOptions.now` half #314's
 * test above used to cover before this issue moved that field off
 * `LocalDayKey` entirely — see `./local-day-key.ts`'s own header comment
 * ("Issue #383 moves QuickAddOptions.now off this brand and onto
 * LocalDateTimeKey below") for why the two fields no longer share one
 * brand, and therefore no longer share one test. Verified by hand for
 * this change: reverting `QuickAddOptions.now` from `LocalDateTimeKey`
 * back to `LocalDayKey` turns every `@ts-expect-error` below into an
 * "unused directive" error, `it.skip` for the identical never-executed
 * reason the blocks above use.
 */
it.skip("compile-only: QuickAddOptions.now rejects a raw string, a UTC instant, or a bare LocalDayKey (issue #383)", () => {
  const rawToday: string = "2026-09-15";
  const utcInstant: string = new Date().toISOString();
  const validDay: LocalDayKey = mustParseLocalDayKey("2026-09-15");
  const validDateTime: LocalDateTimeKey = mustParseLocalDateTimeKey("2026-09-15T13:06");

  // @ts-expect-error — QuickAddOptions.now requires LocalDateTimeKey, not a bare string.
  acceptOptions({ now: rawToday });
  // @ts-expect-error — QuickAddOptions.now: a UTC instant is not a LocalDateTimeKey.
  acceptOptions({ now: utcInstant });
  // The regression #383 itself introduces: a day alone — the *previous*
  // brand this field accepted — is no longer enough. "Nothing silently
  // defaults to midnight" (the issue's own acceptance criterion) is what
  // this line proves: a caller that only has a day, not a real clock
  // reading, cannot compile at all, rather than quietly resolving to
  // `T00:00`.
  // @ts-expect-error — QuickAddOptions.now requires LocalDateTimeKey, not LocalDayKey.
  acceptOptions({ now: validDay });
  // The one legitimate producer — no cast, no `@ts-expect-error` — compiles.
  acceptOptions({ now: validDateTime });
});
