import { describe, expect, it } from "vitest";
import { deferStore, type StoreMethodNames } from "./defer-store";

/**
 * A small stand-in store, deliberately not `EntryStore` itself: proving
 * `deferStore` is generic over any async-method interface, not something
 * that happens to work because it was written against `EntryStore`'s exact
 * shape, is the point of this file — `entry-store-layout.test.tsx` already
 * covers the real `EntryStore` facade end to end.
 */
interface FakeStore {
  greet(name: string): Promise<string>;
  count(): Promise<number>;
}

const FAKE_STORE_METHODS: StoreMethodNames<FakeStore> = {
  greet: true,
  count: true,
};

function fakeStore(): FakeStore {
  return {
    greet: async (name) => `hello ${name}`,
    count: async () => 42,
  };
}

describe("deferStore", () => {
  it("forwards a call made before the promise resolves once it does", async () => {
    let resolveOpen!: (store: FakeStore) => void;
    const promise = new Promise<FakeStore>((resolve) => {
      resolveOpen = resolve;
    });
    const facade = deferStore(promise, (store) => store, FAKE_STORE_METHODS);

    // Called before `promise` has settled — deferStore's whole reason to
    // exist is that this must not throw or return undefined.
    const pending = facade.greet("early");
    resolveOpen(fakeStore());

    await expect(pending).resolves.toBe("hello early");
  });

  it("forwards a call made after the promise has already resolved", async () => {
    const promise = Promise.resolve(fakeStore());
    // Let the promise actually settle before calling the facade, so this
    // exercises the "already open" path distinctly from the pending one above.
    await promise;
    const facade = deferStore(promise, (store) => store, FAKE_STORE_METHODS);

    await expect(facade.count()).resolves.toBe(42);
  });

  it("carries every method named in the method map", async () => {
    const facade = deferStore(Promise.resolve(fakeStore()), (store) => store, FAKE_STORE_METHODS);

    expect(Object.keys(facade).sort()).toEqual(Object.keys(FAKE_STORE_METHODS).sort());
    expect(typeof facade.greet).toBe("function");
    expect(typeof facade.count).toBe("function");
  });
});
