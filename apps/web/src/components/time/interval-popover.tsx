import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { activityIntervalQueryKey } from "@/lib/query-keys";
import { formatDuration } from "@/lib/time-lanes";
import { type ActivityIntervalDetail, fetchActivityInterval } from "@/lib/time-transport";

/**
 * One record's own facts, anchored to the click point inside the block that
 * opened it (issue #429).
 *
 * Detail used to render below a 2880px timeline, so opening a record meant
 * scrolling away from the record itself to read anything about it.
 * `comparative-timeline.tsx`'s `IntervalBlock` owns the actual
 * `Popover`/`PopoverAnchor` (only the open block ever mounts one — see that
 * file's own comment); this file owns only the *content*: the fetch, the
 * facts, and the Android back-button marker.
 *
 * **The anchor is virtual, not the block's own `<button>`.** Wrapping the
 * button itself in `PopoverAnchor asChild` anchors the popover to the whole
 * block — for a record taller than the viewport (an 8-hour block, easily)
 * that puts Radix's positioning at the block's own top or centre, off-screen
 * entirely. `IntervalBlock`'s `virtualAnchorRef` instead reports a zero-size
 * rect at the CLICK point, re-reading the block's live
 * `getBoundingClientRect()` every time Radix asks — see that file's own
 * comment for the geometry. `PopoverAnchor`'s `virtualRef` prop (from
 * `@radix-ui/react-popper`, threaded through unchanged by
 * `PopoverAnchorProps extends PopperAnchorProps`) is what lets it anchor to
 * an arbitrary point instead of a wrapped DOM node — see `PopperAnchor`'s
 * own source: `virtualRef ? null : <Primitive.div ... />`, so nothing is
 * rendered here at all, and the button never has to change parent element
 * type to gain or lose an anchor wrapper. That also removes the biggest
 * hazard a wrapped-button anchor would carry: `onCloseAutoFocus` firing
 * against a button mid-removal from a type-swap unmount. There is no swap
 * left to cause it — `IntervalBlock`'s own comment says why the button is
 * rendered unconditionally, and why focus restoration is owned there.
 *
 * `data-back-dismissible` on `PopoverContent` below: Android's hardware Back
 * button (`platform/back-button.android.ts`) only dismisses overlays it can
 * positively identify as a state-backed dialog rather than letting Back pop
 * the route underneath — this popover is exactly that, and that file's own
 * header comment has the rest of the story.
 */
export function AnchoredIntervalDetail({
  id,
  virtualRef,
  onClose,
}: {
  id: string;
  /** A click-point `Measurable` — see this file's header comment for why the anchor is virtual rather than the block's own `<button>`. */
  virtualRef: React.RefObject<{ getBoundingClientRect: () => DOMRect }>;
  onClose: () => void;
}) {
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      <IntervalPopover id={id} onClose={onClose} />
    </Popover>
  );
}

/**
 * The lazily-loaded content itself, split out from `AnchoredIntervalDetail`
 * only so `comparative-timeline.tsx` can `import()` this whole module
 * without also having to wait on the fetch to know it needs to — Radix's
 * popover and its positioning engine are ~15 KB gzip on their own, which
 * pushed the Time route half again past its `check-bundle-size.mjs` budget,
 * and nobody needs any of it until they open a record.
 */
export function IntervalPopover({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useQuery({
    queryKey: activityIntervalQueryKey(id),
    queryFn: () => fetchActivityInterval(id),
  });

  return (
    <PopoverContent
      role="dialog"
      aria-label="Activity interval"
      // Android's hardware Back button (platform/back-button.android.ts)
      // dismisses this instead of navigating the route underneath — see
      // this file's own header comment for why the marker, not a selector
      // matching every popover, is what makes that safe to opt into.
      data-back-dismissible=""
      align="start"
      sideOffset={4}
      // Keeps the popover fully on screen on a phone even when the block it
      // is anchored to sits near an edge.
      collisionPadding={16}
      style={{ width: "min(22rem, calc(100vw - 2rem))" }}
      className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground text-sm shadow-lg"
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 truncate font-semibold text-sm">
          {query.data?.ok ? query.data.interval.label : "Activity interval"}
        </h3>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>

      {query.isPending ? (
        <p className="text-muted-foreground text-sm">Loading this record…</p>
      ) : query.data?.ok ? (
        <IntervalFacts interval={query.data.interval} />
      ) : (
        <p className="text-muted-foreground text-sm">
          {query.data?.reason === "not-found"
            ? "That record is no longer on this Server."
            : "Couldn't load that record right now."}
        </p>
      )}
    </PopoverContent>
  );
}

function IntervalFacts({ interval }: { interval: ActivityIntervalDetail }) {
  const started = new Date(interval.started_at);
  const ended = new Date(interval.ended_at);

  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <Fact label="Source">
          {interval.source_name}
          {!interval.source_enabled && " (archived)"}
        </Fact>
        <Fact label="Started">{started.toLocaleString()}</Fact>
        <Fact label="Ended">{ended.toLocaleString()}</Fact>
        <Fact label="Duration">{formatDuration(ended.getTime() - started.getTime())}</Fact>
        {interval.detail && <Fact label="Detail">{interval.detail}</Fact>}
        <Fact label="Idle">{interval.idle ? "Reported by the recorder" : "Not reported"}</Fact>
      </dl>

      <details>
        <summary className="cursor-pointer text-muted-foreground text-xs">
          Everything the recorder stored
        </summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {Object.entries(interval.raw_row)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([column, value]) => (
              <Fact key={column} label={column}>
                {/* A BLOB is described rather than printed: its bytes are kept
                    losslessly, but pasting a base64 icon into a list of facts
                    would be noise, not evidence. */}
                {value.type === "blob"
                  ? `binary (${value.base64?.length ?? 0} base64 characters)`
                  : value.type === "null"
                    ? "—"
                    : String(value.value)}
              </Fact>
            ))}
        </dl>
      </details>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
