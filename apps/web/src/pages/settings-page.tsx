import { useQuery } from "@tanstack/react-query";
import { BackToChats } from "@/components/back-to-chats";
import { AiSection } from "@/components/settings/ai-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { ComposerSection } from "@/components/settings/composer-section";
import { DataSection } from "@/components/settings/data-section";
import { SyncSection } from "@/components/settings/sync-section";
import { Shell } from "@/components/shell";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";

/**
 * The Settings Destination (ADR 0036, ADR 0049) — five topic sections, each
 * internally sub-grouped by who owns the setting (issue #202): Appearance,
 * Composer, AI, Sync and Data, in that order. Splitting a ~735-line file of
 * seven flat sections into `apps/web/src/components/settings/` is what this
 * ticket did first, as a no-behaviour-change refactor (issue #202's own
 * "take it apart" step); this file is what's left once every topic owns its
 * own controls — imports, the five sections in the order a reader sees
 * them, and the one thing none of them can get for itself: the Entry
 * store's own handle, opened here and passed down to `DataSection` alone,
 * the only topic whose setting (Export) needs it.
 *
 * A Device setting applies instantly and cannot fail; a Server setting
 * round-trips through a request that can (this ticket's own "why it is
 * worth fixing"). Every topic section keeps that distinction visible with
 * its own "On this device" sub-group — "On the server" arrives once a
 * Server setting exists to fill it — so the two never look identical on a
 * page where they behave differently.
 */
export function SettingsPage() {
  // Settings is a sibling route outside EntryStoreLayout (ADR 0008/0009), so
  // it has no store handle of its own — subscribing to the same
  // entryStoreQueryOptions SyncLoop uses (use-sync-loop.ts) is how it learns
  // whether the store is open, without duplicating how it's opened. Passed
  // down as a prop rather than read a second time inside DataSection: this
  // page is Settings' one composition root, and every other topic section
  // needs no such handle at all (see DataSection's own doc comment).
  const storeQuery = useQuery(entryStoreQueryOptions);
  const opened = storeQuery.data;

  return (
    // Settings gets the same persistent Nav as every other page (ticket 54
    // — "every page becomes reachable directly"), even though Settings
    // itself is a sibling route outside EntryStoreLayout (ADR 0008/0009):
    // Nav is four bare route links, not a reader of the Entry store, so
    // it's just as live here as it is on Composer/Reflect/Digest regardless
    // of whether the store ever opens.
    //
    // No `back` slot any more (issue #75, superseding ADR 0019's "Back
    // returns to Settings" — that decision existed only because Settings
    // used to be reachable but not a destination in its own right, so
    // "where the user was" was the only useful thing Settings could say
    // about leaving. Settings is now itself one of the four Nav
    // destinations (nav.tsx's DESTINATIONS), same as Composer/Reflect/
    // Digest, none of which get a Back either — ADR 0018's original
    // argument for that ("with the destination always reachable, a back
    // affordance only described where the user had been, not where they
    // could go") applies to Settings now for the same reason it always
    // applied to the other three.
    <Shell title="Settings" back={<BackToChats />}>
      <div className="flex flex-col gap-6">
        <AppearanceSection />
        <ComposerSection />
        <AiSection />
        <SyncSection />
        <DataSection opened={opened} />
      </div>
    </Shell>
  );
}
