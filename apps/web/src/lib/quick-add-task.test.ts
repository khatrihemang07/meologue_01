import { mustParseLocalDayKey, parseQuickAdd } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { taskFieldsForRename, taskFieldsFromQuickAdd } from "./quick-add-task";

const NOW = mustParseLocalDayKey("2026-09-02"); // Wednesday.

function fields(input: string, options: { smartDates?: boolean } = {}) {
  const parseOptions = { now: NOW, ...options };
  const result = parseQuickAdd(input, parseOptions);
  return taskFieldsFromQuickAdd(input, result, parseOptions);
}

function renameFields(input: string, options: { smartDates?: boolean } = {}) {
  const parseOptions = { now: NOW, ...options };
  const result = parseQuickAdd(input, parseOptions);
  return taskFieldsForRename(input, result, parseOptions);
}

describe("taskFieldsFromQuickAdd", () => {
  it("resolves date, priority and content for an ordinary line", () => {
    // The ticket's own worked example.
    const result = fields("buy milk tomorrow p1 #Shopping");

    expect(result.date).toBe("2026-09-03");
    expect(result.priority).toBe(4); // p1 UI == stored 4.
    // Issue #370: "#Shopping" is a recognised project token, and Task now
    // has somewhere for it to land — use-projects.ts's `resolveProjectId`
    // is the async second half (mirroring `labelNames` below), so its span
    // is stripped from `content` exactly like any other supported token.
    expect(result.content).toBe("buy milk");
    expect(result.projectName).toBe("Shopping");
  });

  it("resolves a @label into labelNames, not labelIds — resolution is a caller concern", () => {
    const result = fields("call mum @Family");

    expect(result.labelNames).toEqual(["Family"]);
    expect(result.content).toBe("call mum");
  });

  it("keeps a leading uncompletable marker's text rather than dropping it", () => {
    const result = fields("* buy milk");

    expect(result.content).toBe("* buy milk");
  });

  it("keeps a //description's text rather than dropping it", () => {
    const result = fields("buy milk //2% please");

    expect(result.content).toBe("buy milk //2% please");
  });

  it("keeps a !reminder's text rather than dropping it — Task has no reminder field yet", () => {
    const result = fields("buy milk !5pm");

    expect(result.content).toBe("buy milk !5pm");
  });

  describe("recurrence", () => {
    it("resolves a bare recurrence word to its canonical 'every ...' phrase", () => {
      const result = fields("Create monthly report");

      expect(result.dateString).toBe("every month");
      expect(result.content).toBe("Create report");
    });

    it("computes the first occurrence from the canonical phrase — today, since nothing about a bare 'monthly' fails to match its own creation day (issue #191)", () => {
      // "monthly" resolved with no other date token present — date should
      // be a real occurrence ../recurrence/'s firstOccurrence computed,
      // not simply left null. Before issue #191's fix this landed a whole
      // month out (`> NOW`), because the engine's only search skipped
      // past the origin unconditionally; firstOccurrence's origin is
      // `now` itself here (no due date token to anchor to), and a
      // monthly cadence always matches its own origin trivially, so the
      // correct first occurrence is today.
      const result = fields("pay rent monthly");

      expect(result.dateString).toBe("every month");
      expect(result.date).toBe(NOW);
    });

    it("every bare word in en.ts's recurrenceWords table maps to a phrase firstOccurrence accepts", () => {
      for (const word of [
        "daily",
        "weekly",
        "fortnightly",
        "biweekly",
        "monthly",
        "yearly",
        "annually",
      ]) {
        const result = fields(`task ${word}`);
        expect(result.dateString, word).not.toBeNull();
        expect(result.date, word).not.toBeNull();
      }
    });

    // Before issue #291, this test's whole point was that "daily" is
    // completion-anchored regardless of any due date, so its resolved
    // date landed on `now` even when an unrelated "tomorrow" token also
    // matched — proving the override in taskFieldsFromQuickAdd's own
    // header comment ("recurrence.date, when present, is the one true due
    // date") was doing real work, not just coinciding with result.date.
    // #291 retired that exception (../../packages/core/src/recurrence/
    // recurrence.ts's module doc comment): a bare "every day" is now
    // due-anchored like every other frequency, so a dueDate that happens
    // to be present at *creation* time is used as the anchor here too —
    // the identical behaviour "every month"/"every year" (already
    // due-anchored) already had, and this file's own header comment on
    // `taskFieldsFromQuickAdd` already named for "monthly starting
    // tomorrow". That means this specific input can no longer demonstrate
    // the override diverging from a coincidental date token — every bare
    // word in RECURRENCE_WORD_TO_PHRASE now resolves to a phase-locked
    // frequency that trivially matches its own origin, so recurrence.date
    // and the coincidental "tomorrow" token always agree. This test is
    // kept as a correctness check of the new, uniform due-anchoring
    // instead: "daily starting tomorrow" resolves to tomorrow, not today.
    it('"daily starting tomorrow" is due-anchored to the coincidental "tomorrow" token, matching every other bare recurrence word (issue #291)', () => {
      // "daily starting tomorrow" — "starting" isn't a clause a bare word
      // understands (RECURRENCE_WORD_TO_PHRASE's own header comment: a
      // bare word maps onto a fixed literal phrase, nothing more), so
      // "tomorrow" is left to parse as its own, independent plain date
      // token (result.date, 2026-09-03) alongside the separately-
      // recognised "daily" recurrence token, and that token is what
      // resolveRecurrence receives as `dueDate`.
      const result = fields("review daily starting tomorrow");

      expect(result.dateString).toBe("every day");
      expect(result.date).toBe("2026-09-03");
    });

    it("no recurrence token leaves dateString null and date untouched", () => {
      const result = fields("buy milk tomorrow");

      expect(result.dateString).toBeNull();
      expect(result.date).toBe("2026-09-03");
    });

    describe("typed as a phrase (issue #188), not a bare word", () => {
      it("stores the phrase itself, verbatim, as dateString — no canonical substitution needed", () => {
        const result = fields("water the plants every day");

        // Unlike a bare word, a phrase is already legal
        // ../../packages/core/src/recurrence/ input — nothing to bridge
        // (quick-add-task.ts's own header comment on RECURRENCE_WORD_TO_PHRASE
        // explains why this is a stronger reading of CONTEXT.md's "what
        // the user typed is what is stored, unchanged" than a bare word
        // can offer).
        expect(result.dateString).toBe("every day");
        expect(result.content).toBe("water the plants");
        expect(result.date).not.toBeNull();
      });

      it("every named phrase form resolves to a real occurrence", () => {
        for (const [input, expectedDateString] of [
          ["water the plants every day", "every day"],
          ["call mum every monday", "every monday"],
          ["water the plants every 2 weeks", "every 2 weeks"],
          ["submit report every 3rd friday", "every 3rd friday"],
          ["water plants every! 2 weeks", "every! 2 weeks"],
        ] as const) {
          const result = fields(input);
          expect(result.dateString, input).toBe(expectedDateString);
          expect(result.date, input).not.toBeNull();
        }
      });

      it("a phrase's own computed date overrides a separate, explicit date token elsewhere in the input — landing on that date itself (issue #191)", () => {
        // "27 Jan" is its own, independently-recognised date token
        // (nothing about it is inside the recurrence phrase's own span);
        // the recurring Task's first occurrence is still computed from
        // it as the due-anchor, rather than "27 Jan" being stored as the
        // Task's due date directly — but the computed occurrence now
        // *is* the 27th itself, not one month past it. Before issue
        // #191's fix, a due-anchored "every month" always stepped one
        // full interval past its own anchor even when nothing had been
        // completed yet, landing on 2027-02-27 instead of the 27th the
        // user actually typed — precisely the "buy milk friday every 2
        // weeks should land on that Friday itself" case the issue names.
        // firstOccurrence's origin (the 27th) always matches a monthly
        // cadence trivially, so it's returned unchanged.
        const result = fields("pay rent 27 Jan every month");

        expect(result.dateString).toBe("every month");
        expect(result.date).toBe("2027-01-27");
        expect(result.content).toBe("pay rent");
      });

      it("a phrase's own 'starting' clause is captured whole rather than left as a separate date token", () => {
        const result = fields("pay rent every month starting 1 oct");

        expect(result.dateString).toBe("every month starting 1 oct");
        expect(result.content).toBe("pay rent");
      });

      it("a phrase the recurrence engine can't parse is left as ordinary words — no dateString, no content stripped", () => {
        const result = fields("water plants every fortnight");

        expect(result.dateString).toBeNull();
        expect(result.content).toBe("water plants every fortnight");
      });

      it("smartDates off suppresses a phrase exactly as it does a bare word", () => {
        const result = fields("water the plants every day", { smartDates: false });

        expect(result.dateString).toBeNull();
        expect(result.content).toBe("water the plants every day");
      });
    });
  });

  describe("smartDates off", () => {
    it("stops recognising a bare recurrence word", () => {
      const result = fields("Create monthly report", { smartDates: false });

      expect(result.dateString).toBeNull();
      expect(result.content).toBe("Create monthly report");
    });

    it("still recognises sigil-marked tokens", () => {
      const result = fields("buy milk p1 @Shopping", { smartDates: false });

      expect(result.priority).toBe(4);
      expect(result.labelNames).toEqual(["Shopping"]);
      expect(result.content).toBe("buy milk");
    });
  });
});

describe("taskFieldsForRename", () => {
  it("leaves every field null or empty on plain text with no recognised token", () => {
    const result = renameFields("buy milk");

    expect(result.content).toBe("buy milk");
    expect(result.date).toBeNull();
    expect(result.deadline).toBeNull();
    expect(result.priority).toBeNull();
    expect(result.dateString).toBeNull();
    expect(result.labelNames).toEqual([]);
  });

  it("resolves priority: null when no p-token was typed", () => {
    const result = renameFields("buy milk tomorrow");

    expect(result.priority).toBeNull();
    expect(result.date).toBe("2026-09-03");
  });

  // The sharpest case: `taskFieldsFromQuickAdd`'s own `priority` is
  // already `1` here (storedPriorityOf's degenerate p4 -> 1 mapping,
  // ../../packages/core/src/quick-add/types.ts's own doc comment on
  // `QuickAddResult.priority` — "Defaults to 1 … matching `Task.priority`'s
  // own default"), the exact same `1` a Task that never had ANY priority
  // token typed also carries. `taskFieldsForRename` is what tells the two
  // apart: `result.tokens` holds a real `"priority"` entry for `p4`, so
  // this resolves to `1`, not `null` — a rename to "... p4" must still
  // overwrite an existing `p1`/`p2`/`p3`, which a `null` here would wrongly
  // read as "nothing to change."
  it("resolves priority: 1 (not null) when p4 is explicitly typed", () => {
    const result = renameFields("buy milk p4");

    expect(result.priority).toBe(1);
    expect(result.content).toBe("buy milk");
  });

  it("resolves priority to the stored value for an ordinary p-token, exactly as taskFieldsFromQuickAdd does", () => {
    const result = renameFields("buy milk p1");

    expect(result.priority).toBe(4);
  });
});
