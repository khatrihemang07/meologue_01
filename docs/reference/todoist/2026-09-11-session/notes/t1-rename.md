## What to build

Typing a date phrase while **renaming** a Task resolves it, exactly as Quick Add already does.

Today, typing `tom` into Quick Add stores the Task as "buy milk" due Tomorrow — the phrase is
recognised, resolved into the Date field, and stripped from the title. Renaming behaves differently
on both of its surfaces:

- **Inline row rename** (the hover pencil): recognition never fires at all — the title editor is
  mounted without the recognition plugin — and the typed text is saved verbatim.
- **Detail-view rename**: recognition *highlights* the phrase, so it looks like it worked, but
  saving commits the raw text and sets no date.

Driven end to end, renaming "buy milk" to "buy milk tom tmr" stored that literal string and left
the date untouched. That is what this ticket fixes.

Both rename surfaces should go through **one shared door**, not two implementations — the existing
Quick Add field resolution already produces the stripped content and the resolved fields, so reuse
it rather than writing a second resolver.

**Important guard:** only *set* a field when a phrase actually resolved. A rename must never
silently clear a date the reader didn't touch. Todoist's behaviour here was never captured, so the
conservative rule stands.

Note this reverses a previously deliberate deferral — the detail view's own comment explains that
saving stayed unparsed because the reference corpus was silent on it, and an existing test
*asserts* the verbatim commit. That assertion inverts as part of this work.

## Acceptance criteria

- [ ] Renaming a Task to `<name> tom` in the **inline row editor** stores `<name>` and sets the
      Date to tomorrow
- [ ] The same is true in the **detail view** rename
- [ ] Recognition highlights the phrase in the inline row editor while typing (it currently does
      not fire there at all)
- [ ] A rename containing no date phrase leaves an existing Date, Deadline, Priority and Labels
      untouched
- [ ] Both surfaces resolve through one shared code path, not two
- [ ] Priority, Deadline, Recurrence and `@label` phrases resolve on rename the same way Quick Add
      resolves them
- [ ] The existing test asserting a verbatim detail-view commit is inverted, and the new behaviour
      is covered on both surfaces
- [ ] Parity ledger rows for detail-title recognition are restatused with evidence

## Blocked by

None — can start immediately.
