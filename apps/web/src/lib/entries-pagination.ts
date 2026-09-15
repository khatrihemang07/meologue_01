import type { Entry, EntryPage, EntryStore } from "@meologue/core";
import type { InfiniteData } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";

/**
 * Issue #79: History opens 50 Entries at a time instead of the whole
 * History, and widens 50 at a time as the reader scrolls back. Pulled out
 * of use-history.ts (rather than living inline there) because
 * sync-runner.ts needs the same shape without importing use-history.ts
 * itself — use-history.ts already imports sync-runner.ts's `requestSync`,
 * and the reverse import would be a cycle (the same reason query-keys.ts
 * exists as its own file already).
 */
export const ENTRIES_PAGE_SIZE = 50;

/** What each page's `pageParam` is — literally EntryStore's own page argument (packages/core/src/store.ts). */
export type EntriesPageParam = EntryPage;

/** The first page ever fetched: no cursor, just the newest ENTRIES_PAGE_SIZE Entries. */
export const INITIAL_ENTRIES_PAGE_PARAM: EntriesPageParam = { limit: ENTRIES_PAGE_SIZE };

type EntriesInfiniteData = InfiniteData<Entry[], EntriesPageParam | undefined>;

/**
 * useInfiniteQuery's `getNextPageParam` (use-history.ts): the next page is
 * "everything older than the last Entry this page loaded," capped at
 * ENTRIES_PAGE_SIZE — the standard keyset-pagination shape, using the
 * oldest loaded Entry's (createdAt, id) as the cursor rather than an
 * offset, so a page boundary can never shift out from under an Entry that
 * arrives or is edited elsewhere while the reader has this page open (see
 * EntryPage's own doc comment in packages/core/src/store.ts). A page
 * shorter than ENTRIES_PAGE_SIZE means list() ran out of Entries before
 * filling it — there is no next page.
 */
export function nextEntriesPageParam(lastPage: Entry[]): EntriesPageParam | undefined {
  if (lastPage.length < ENTRIES_PAGE_SIZE) {
    return undefined;
  }
  const oldestLoaded = lastPage[lastPage.length - 1] as Entry;
  return {
    before: { createdAt: oldestLoaded.createdAt, id: oldestLoaded.id },
    limit: ENTRIES_PAGE_SIZE,
  };
}

/**
 * Refreshes only the newest loaded page of History, in place, rather than
 * refetching every page the reader has scrolled back through.
 *
 * Before this ticket, a sync tick or a local write (Send/edit/delete)
 * called `queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY })`,
 * which against a plain useQuery just refetched the one list it held.
 * Against an infinite query, TanStack Query's default invalidation
 * behaviour is to refetch *every* currently-held page, sequentially, to
 * keep them internally consistent — harmless at page 1, but it means every
 * sync tick gets more expensive the further back the reader has scrolled,
 * which is exactly the regression this ticket exists to avoid. Only the
 * newest page can actually change from a sync pull or a local write
 * landing at the newest end (Sends only ever add there, and Sync/edits/
 * deletes reaching further back is the rare case this trades away
 * deliberately — a reader scrolled back who happens to edit or delete
 * something they scrolled to sees it catch up next time this page (or
 * theirs) refreshes, not instantly), so refreshing just that page is both
 * cheaper and gives the same result for the common case.
 *
 * TanStack's `maxPages` option was the other candidate the ticket named,
 * and it was rejected: `maxPages` caps how many pages stay *cached* by
 * evicting from the end *opposite* wherever the next page was fetched —
 * since older pages are fetched by appending via `fetchNextPage`, the
 * evicted page would be page 0, the newest, the one page this app can
 * never afford to drop while the reader is looking at it. It solves a
 * memory problem this app doesn't have yet, not the "which page refetches"
 * problem this ticket does have.
 *
 * This does a *boundary-aware* refetch, not "just fetch a fresh newest
 * 50": it re-reads everything newer than wherever the *second* page
 * starts (`pageParams[1]`), whatever that count now is, rather than a
 * fixed 50. A fixed-50 refetch would be wrong the moment an Entry inside
 * the old page 0 is deleted — the fresh 50 would then reach one Entry
 * further back to make up the count, an Entry that (unaware of the
 * refresh) is still sitting at the front of the untouched page 1, so the
 * flattened list would show it twice. Bounding by the *cursor* the second
 * page already committed to, instead of a count, means page 0's refreshed
 * content and page 1's untouched content can never overlap, however many
 * Entries page 0 now actually holds. With only one page loaded (the
 * reader hasn't scrolled back yet), there is no second page's cursor to
 * bound by, so this falls back to the same "freshest ENTRIES_PAGE_SIZE"
 * shape the very first fetch used.
 *
 * A no-op if History's query has never been observed yet (`current` is
 * undefined) — nothing is rendering it, so there's nothing to refresh; the
 * eventual first mount reads current data anyway.
 */
/**
 * Drops every loaded page but the newest, in place — no network/store call,
 * unlike `refreshNewestEntriesPage` above, because the newest page's own
 * content isn't in question here, only how much of History's *other*
 * loaded content stays around for a fresh mount to render.
 *
 * Why this exists at all: a reload starts `useHistory`'s infinite query
 * cold — one page, ~50 Entries, almost all of them measured within a
 * couple of frames, so the newest-end jump lands correctly (scroll-
 * to-newest-check.md's own measured baseline). Returning to the Composer
 * from Reflect (or Todo, or Digest) is not a reload: `EntryStoreLayout`
 * (this hook's own caller) sits above every one of those routes and never
 * unmounts between them, so `useHistory`'s query keeps every page the
 * reader ever paged back through — a year of scrolling can leave hundreds
 * of Entries cached, most of them never rendered again yet still fed to a
 * freshly-mounted History, which virtualizes them all sight-unseen at
 * their *estimated* row height. `el.scrollHeight` right after that mount is
 * whatever that estimate adds up to — measured live at 40,000–122,000px
 * against a real ~6,000px — and jumping to "newest" against a fictional
 * height lands in the middle of the document, not at the bottom (the
 * defect this function exists to prevent).
 *
 * Trimming back to one page is what makes a fresh Composer mount cost
 * exactly what a reload already costs, deliberately mirroring it rather
 * than inventing a second "how much History should a fresh mount show"
 * answer: page zero is kept (not merely re-requested) because
 * `refreshNewestEntriesPage` already keeps it caught up on every local
 * write and sync tick, so there's nothing stale about it to justify a
 * fetch — only the *other* pages, which a fresh mount has no use for until
 * the reader scrolls back and asks for them again (ordinary
 * `fetchNextPage` calls, unaffected: `nextEntriesPageParam`'s cursor comes
 * from the oldest Entry actually loaded, not an offset, so re-fetching a
 * page this trimmed away lands on the identical content it held before).
 *
 * A no-op with zero or one page loaded — nothing to trim — which is also
 * what keeps this harmless to call on every ordinary render of whichever
 * route decides when a mount counts as "fresh" (see that call site's own
 * comment for the routing-level rule).
 */
export function resetEntriesPagingToNewest(): void {
  const current = queryClient.getQueryData<EntriesInfiniteData>(ENTRIES_QUERY_KEY);
  if (current === undefined || current.pages.length <= 1) {
    return;
  }
  queryClient.setQueryData<EntriesInfiniteData>(ENTRIES_QUERY_KEY, {
    pages: current.pages.slice(0, 1),
    pageParams: current.pageParams.slice(0, 1),
  });
}

export async function refreshNewestEntriesPage(store: EntryStore): Promise<void> {
  const current = queryClient.getQueryData<EntriesInfiniteData>(ENTRIES_QUERY_KEY);
  if (current === undefined || current.pages.length === 0) {
    return;
  }
  const secondPageParam = current.pageParams[1];
  const refreshedPage = await store.list(
    secondPageParam?.before ? { before: secondPageParam.before } : INITIAL_ENTRIES_PAGE_PARAM,
  );
  queryClient.setQueryData<EntriesInfiniteData>(ENTRIES_QUERY_KEY, {
    pages: [refreshedPage, ...current.pages.slice(1)],
    pageParams: current.pageParams,
  });

  // Search (ADR 0014) narrows the same Entries but is its own unbounded
  // query, keyed as a child of ENTRIES_QUERY_KEY (use-entry-search.ts:
  // `[...ENTRIES_QUERY_KEY, "search", query]`) specifically so it used to
  // ride along with the whole-key invalidation this function replaces.
  // Invalidating that prefix on its own here is what keeps an active
  // Search catching up after a sync tick or a local write — unaffected by
  // this ticket's paging change, per the ticket's own acceptance
  // criterion — without also re-triggering the newest-page-only logic
  // above a second time (this key never matches ENTRIES_QUERY_KEY itself).
  await queryClient.invalidateQueries({ queryKey: [...ENTRIES_QUERY_KEY, "search"] });

  // Issue #143: an Entry Reference's chip (entry-row.tsx's
  // `EntryReferenceLink`, query-keys.ts's own `entryReferenceQueryKey`) is
  // ADR 0042's "resolves live rather than storing a snapshot" — a chip
  // already mounted and pointing at whatever Entry this write just touched
  // has to notice. Same shape as the Search invalidation just above, and
  // the same reason it lives here rather than in a per-mutation
  // `onSuccess`: every local write (Send, edit, delete) and every sync pull
  // funnels through this one function already, so one invalidation here
  // covers all of them instead of one per call site.
  await queryClient.invalidateQueries({ queryKey: [...ENTRIES_QUERY_KEY, "entry-reference"] });

  // Issue #147: a day's own "what Refers to me?" row (history.tsx's
  // `DayReferrersRow`, query-keys.ts's own `dayReferrersQueryKey`) needs the
  // same live catch-up as Search and an Entry Reference chip do — the exact
  // same reason, one line up. A new `[[date]]` Reference just Sent, or an
  // edit/delete that added or removed one from an existing Entry, has to
  // change what the day it names reports.
  await queryClient.invalidateQueries({ queryKey: [...ENTRIES_QUERY_KEY, "day-referrers"] });
}
