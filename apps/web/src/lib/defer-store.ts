/**
 * The mechanism behind `entry-store-layout.tsx`'s own `deferUntilOpen` —
 * issue #110's fix, extracted here (issue #167) because Todo's TaskStore is
 * a second thing that needs the identical treatment, over the identical
 * open promise, and a second hand-written nine-method forwarding object
 * beside the first is exactly the drift this module exists to prevent. See
 * entry-store-layout.tsx's own doc comment for *why* a deferred facade has
 * to exist at all (useHistory needs a real store synchronously, from that
 * layout's very first render, and issue #110's fix depends on the
 * layout's own returned type never changing across renders) — this module
 * only generalises *how* one is built, not why one is needed.
 *
 * `select` picks one store out of whatever the open promise eventually
 * resolves to (e.g. `({ store }) => store` for the Entry store, `({
 * taskStore }) => taskStore` for a future Task one) — see
 * `packages/core/src/sqlite/open.ts`'s own doc comment on why that result
 * is a flat, additive shape rather than one nested store's fields shifting
 * out from under an existing selector.
 */

// Every store method this module forwards resolves a Promise — EntryStore
// (packages/core/src/store.ts) is entirely async, and so is any store
// built the same way over the same SqliteDriver seam. A synchronous method
// would break `deferUntilOpen`'s whole point: nothing here can call a
// method before `promise` settles without going through `.then`.
//
// Self-referential (`S extends AsyncStore<S>`, not `S extends
// Record<string, ...>`) so a plain interface like `EntryStore` — no index
// signature, and this module must never demand one just to be usable —
// satisfies the constraint structurally, key by key. `any[]`, not
// `unknown[]`, is what makes an arbitrary method — `edit(id: string, body:
// string): Promise<void>` included — assignable to this constraint at
// all: parameters are contravariant, so `unknown[]` here would reject
// every method with a narrower, real parameter type instead of accepting
// it as a bound.
// biome-ignore lint/suspicious/noExplicitAny: see comment above — this `any` is the constraint's own bound, never a value this module reads.
type AsyncStore<S> = { [K in keyof S]: (...args: any[]) => Promise<unknown> };

/**
 * Requires exactly one entry per key of `S`, no more and no fewer — not
 * `(keyof S)[]`, which TypeScript only checks in one direction (every
 * listed name really is a key of `S`), never the direction that matters
 * here (every key of `S` got listed). An object literal passed where this
 * type is expected is checked both ways: a key of `S` missing from the
 * literal is a "property is missing" error, and a key in the literal that
 * isn't a key of `S` is an excess-property error. That is the whole reason
 * to build the method list this way — a method added to a store's
 * interface and simply forgotten at its `deferStore` call site is a
 * compile error, not a runtime one. The alternative would compile clean
 * and fail only as `undefined is not a function`, and only on whichever
 * call happens to race the store's own open — precisely the path hardest
 * to hit in a test, since every other call in the app waits for `data` to
 * exist first (see `entry-store-layout.tsx`'s `store = data?.store ??
 * pendingStore`).
 */
export type StoreMethodNames<S extends AsyncStore<S>> = { readonly [K in keyof S]: true };

/**
 * Builds a facade of type `S` that forwards every method named in
 * `methods` to `select(await promise)`. A call made before `promise`
 * settles waits for that same open to finish, rather than failing or
 * silently doing nothing; a call made after settles resolves against the
 * already-kept promise with no extra delay. Nothing here ever starts a
 * second open — `promise` is always the one already in flight (or already
 * settled) at the composition root, the same single door
 * `entryStoreQueryOptions`'s own comment guarantees for the Entry store.
 */
export function deferStore<R, S extends AsyncStore<S>>(
  promise: Promise<R>,
  select: (result: R) => S,
  methods: StoreMethodNames<S>,
): S {
  const facade = {} as S;
  for (const key of Object.keys(methods) as (keyof S)[]) {
    facade[key] = ((...args: Parameters<S[typeof key]>) =>
      promise.then((result) => select(result)[key](...args))) as S[typeof key];
  }
  return facade;
}
