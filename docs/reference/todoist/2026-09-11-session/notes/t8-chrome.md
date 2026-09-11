## What to build

Todo's page should read like Todoist's page. This is the largest change to how the app *feels*, and
the previous parity programme judged it the main reason it doesn't.

**Measured side by side at the same viewport:**

| | Todoist | meologue |
|---|---|---|
| Content column | fixed **800px**, beside a 280px sidebar | proportional — 971px inside a 1142px pane |
| View name | an in-column heading, **26px / weight 700 / 35px line-height** | a 16px span in a separate app bar |
| Headings in the DOM | the view name is a real `h1` | **zero `h1` elements anywhere in Todo** |

Two parts.

**The column.** Cap it at 800px above the 900px breakpoint. Reuse that existing breakpoint rather
than inventing another — 900px is already where Todo changes shape (the sidebar appears, the bottom
bar unmounts), so a second transition a hundred-odd pixels away would be arbitrary. **Below 900px
Todo stays exactly as every other Destination**, which keeps the phone layout untouched and is the
honest choice, since Todoist's numbers were only ever measured with its sidebar on screen.

The column is owned by the shared shell and used by every Destination, so this must be additive and
default-preserving: callers that ask for nothing keep today's behaviour byte-for-byte.

> **Correction to an earlier reading of the capture.** The 800px column is *not* flush-left against
> the sidebar — it sits roughly centred in the remaining space (gutters 188/202). "Left-aligned"
> describes the heading's text alignment inside the column, not the column's position in the pane.
> So centring stays; only the width *mechanism* changes.

**The heading.** Remove the app bar for Todo and render the view name as a real heading at the top
of the scrollable column, with Back and the sync indicator moving into that same row. The name
comes from the view already being rendered — Inbox, Today, Upcoming, a Project's or Filter's own
name, and so on.

**An accepted consequence, recorded rather than absorbed quietly:** Back and the sync indicator
currently sit in a bar that never scrolls. In the column they scroll away with the list, so a
reader deep in a long Inbox loses the always-visible way home. Todoist has the identical property,
so this is the faithful choice — but it is a real loss and belongs in the ADR text, not buried in a
diff. Consider a follow-up giving the narrow-screen bottom bar a way home.

**ADR work:** the ADR governing the proportional column states it "governs every route", which this
change makes false for one Destination — it needs a short amendment in the same change. Nothing
defends the app bar's current shape, so removing it contradicts no decision, but *that* deserves
recording too.

## Acceptance criteria

- [ ] Above 900px, Todo's content column caps at 800px; other Destinations are unchanged
- [ ] Below 900px, Todo's column is identical to every other Destination's, and the bottom bar
      still works
- [ ] Todo renders its view name as a real heading at 26px / weight 700 / 35px line-height
- [ ] Todo shows no separate app bar; Back and the sync indicator render in the heading row
- [ ] The heading reflects the current view, including a Project's or Filter's own name
- [ ] Every other Destination's app bar is untouched
- [ ] The existing shared-column end-to-end contract still passes, and a new assertion covers
      Todo's own column at both sides of the breakpoint
- [ ] The proportional-column ADR is amended; the removal of Todo's app bar and the
      scrolling-Back consequence are both recorded
- [ ] Parity ledger rows for the column and heading restatused with measured evidence

## Blocked by

- #248 — both change where Back renders, and doing them in one window means debugging two moving
  parts at once.
