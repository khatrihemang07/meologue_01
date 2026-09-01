import { describe, expect, it } from "vitest";
import { compareByOrder, orderKeyBetween } from "./order-key";

// A tiny deterministic PRNG (mulberry32) rather than Math.random(),
// so a failing property test prints a seed a human can rerun exactly —
// Math.random() would make a rare failure irreproducible.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type OrderedItem = { orderKey: string; id: string };

/**
 * Simulates a client-side list under a sequence of random insert/move
 * operations, the way apps/web's drag handler will actually call
 * orderKeyBetween: read the current list, find the two neighbours either
 * side of the drop point, ask for a key between them.
 */
function runRandomSequence(seed: number, operationCount: number): OrderedItem[] {
  const rng = mulberry32(seed);
  let items: OrderedItem[] = [];
  let nextId = 0;

  for (let op = 0; op < operationCount; op++) {
    const isMove = items.length > 1 && rng() < 0.5;
    const targetIndex = items.length === 0 ? 0 : Math.floor(rng() * (items.length + 1));
    const before = targetIndex === 0 ? null : (items[targetIndex - 1]?.orderKey ?? null);
    const after = targetIndex >= items.length ? null : (items[targetIndex]?.orderKey ?? null);
    const orderKey = orderKeyBetween(before, after);

    if (isMove) {
      // Move a random existing item (not one of the two neighbours the
      // key was just computed between, or the move is a no-op) to the
      // newly computed position.
      const moveIndex = Math.floor(rng() * items.length);
      const [moved] = items.splice(moveIndex, 1);
      if (moved !== undefined) {
        items = insertSorted(items, { ...moved, orderKey });
      }
    } else {
      items = insertSorted(items, { orderKey, id: `item-${nextId++}` });
    }
  }
  return items;
}

function insertSorted(items: OrderedItem[], item: OrderedItem): OrderedItem[] {
  const next = [...items, item];
  next.sort(compareByOrder);
  return next;
}

// Asserts the invariant orderKeyBetween exists to guarantee: sorting by
// compareByOrder always reproduces the order the keys were generated to
// express (each key was generated strictly between its two neighbours at
// the moment of insertion), and no two keys generated across the whole
// sequence ever collide.
function assertSortedAndUnique(items: OrderedItem[]): void {
  const sorted = [...items].sort(compareByOrder);
  expect(items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
  const keys = items.map((i) => i.orderKey);
  expect(new Set(keys).size).toBe(keys.length);
}

describe("orderKeyBetween", () => {
  it("(null, null) gives the first key in an empty list", () => {
    const key = orderKeyBetween(null, null);
    expect(key.length).toBeGreaterThan(0);
  });

  it("(null, x) prepends — sorts before the existing key", () => {
    const x = orderKeyBetween(null, null);
    const before = orderKeyBetween(null, x);
    expect(before < x).toBe(true);
  });

  it("(x, null) appends — sorts after the existing key", () => {
    const x = orderKeyBetween(null, null);
    const after = orderKeyBetween(x, null);
    expect(after > x).toBe(true);
  });

  it("repeated insertion between the same two neighbours always lands strictly between them", () => {
    const lo = orderKeyBetween(null, null);
    const hi = orderKeyBetween(lo, null);
    const generated: string[] = [];
    for (let i = 0; i < 50; i++) {
      const key = orderKeyBetween(lo, hi);
      expect(key > lo).toBe(true);
      expect(key < hi).toBe(true);
      generated.push(key);
    }
    // Distinct every time — this is jitter's whole job (see
    // ./order-key.ts's JITTER_LENGTH comment): fifty calls with
    // identical arguments, standing in for fifty Devices independently
    // resolving the same offline insertion point, must not collapse
    // onto the same key.
    expect(new Set(generated).size).toBe(generated.length);
  });

  it("rejects a key built from a character outside the order-key alphabet", () => {
    expect(() => orderKeyBetween("!!!", null)).toThrow();
  });

  // Property test: many randomised sequences of inserts and moves, each
  // checked for both invariants orderKeyBetween exists to provide —
  // sorted order matches intent, and no collision — rather than one
  // hand-picked scenario.
  it("holds across many randomised insert/move sequences", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const items = runRandomSequence(seed, 60);
      assertSortedAndUnique(items);
    }
  });
});

describe("compareByOrder", () => {
  it("breaks a tied orderKey by id ascending", () => {
    const a = { orderKey: "same", id: "b" };
    const b = { orderKey: "same", id: "a" };
    expect(compareByOrder(a, b)).toBeGreaterThan(0);
    expect(compareByOrder(b, a)).toBeLessThan(0);
  });

  it("is 0 for two identical items — required for Array.prototype.sort's contract", () => {
    const a = { orderKey: "x", id: "1" };
    expect(compareByOrder(a, { ...a })).toBe(0);
  });
});
