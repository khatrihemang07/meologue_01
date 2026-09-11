## What to build

Todo's wide-screen navigation should be able to reach everything. Right now, at desktop width, it
can reach neither the rest of the app nor one of its own destinations.

**There is no way out of Todo above 900px.** The Back control renders nothing at that width, on the
assumption that the chat list is pinned in the pane beside it. That assumption stopped being true
when the Todo sidebar took that pane over — and the sidebar carries no link out. So a reader at
desktop width cannot reach Composer, Reflection, Digest or Settings without the browser's own Back
or by typing a URL. `CONTEXT.md` defines a Destination as a top-level view listed on the root
screen, and the relevant ADR states Back still returns the reader there — the code doesn't
implement that claim at this breakpoint.

**Todo's own Activity view is unreachable at the same width**, for the same structural reason. It
is linked only from the narrow-screen bottom bar — which hides itself above 900px — and from inside
a specific Project. Todo has two navigations, and this destination was only ever added to one. That
is the identical defect class as the Upcoming view, which shipped unreachable on touch devices for
a full release.

Back should be a real link to the root screen, never a history pop: a reader who opened the URL
cold has no history entry, and a Back that does nothing is worse than one that always lands
somewhere.

## Acceptance criteria

- [ ] A Back affordance reaches the root screen from Todo at **every** width, including above 900px
- [ ] Back still behaves as it does today on Composer, Reflection, Digest and Settings — those
      panes genuinely do still show the chat list
- [ ] Activity is reachable from the wide-screen Todo sidebar
- [ ] Activity remains reachable from the narrow-screen bottom bar
- [ ] Back works on a cold load with no history entry
- [ ] The ADR asserting "Back still returns them to the root screen" is amended to match what the
      code now does, and the stale "the list is already pinned beside this pane" comment is
      corrected
- [ ] Covered by tests at both sides of the 900px breakpoint

**While you're here:** two different ADRs in this repo share the number 0070, which makes every
citation of "ADR 0070" ambiguous. Disambiguate them.

## Blocked by

None — can start immediately.
