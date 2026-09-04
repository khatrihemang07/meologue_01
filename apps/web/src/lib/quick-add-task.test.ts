import { parseQuickAdd } from "@meologue/core";
import { describe, expect, it } from "vitest";
import { taskFieldsFromQuickAdd } from "./quick-add-task";

const NOW = "2026-09-02"; // Wednesday.

function fields(input: string, options: { smartDates?: boolean } = {}) {
  const parseOptions = { now: NOW, ...options };
  const result = parseQuickAdd(input, parseOptions);
  return taskFieldsFromQuickAdd(input, result, parseOptions);
}

describe("taskFieldsFromQuickAdd", () => {
  it("resolves date, priority and content for an ordinary line", () => {
    // The ticket's own worked example.
    const result = fields("buy milk tomorrow p1 #Shopping");

    expect(result.date).toBe("2026-09-03");
    expect(result.priority).toBe(4); // p1 UI == stored 4.
    // "#Shopping" is a recognised project token, but Task has no project
    // field yet (issue #171) — kept as literal content rather than
    // silently dropped (this module's own header comment on
    // UNSUPPORTED_TOKEN_KINDS).
    expect(result.content).toBe("buy milk #Shopping");
  });

  it("resolves a %label into labelNames, not labelIds — resolution is a caller concern", () => {
    const result = fields("call mum %Family");

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

    it("computes the first occurrence from the canonical phrase, not the current date directly", () => {
      // "monthly" resolved with no other date token present — date should
      // be a real future occurrence ../recurrence/'s engine computed, not
      // simply left null or set to `now`.
      const result = fields("pay rent monthly");

      expect(result.dateString).toBe("every month");
      expect(result.date).not.toBeNull();
      expect((result.date as string) > NOW).toBe(true);
    });

    it("every bare word in en.ts's recurrenceWords table maps to a phrase nextOccurrence accepts", () => {
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

    it("a recurring Task's resolved date overrides an unrelated plain date token", () => {
      // "monthly starting tomorrow" — the recurrence's own computed first
      // occurrence is the one true due date, not "tomorrow" read as an
      // independent date token (this module's own header comment on
      // taskFieldsFromQuickAdd explains why).
      const result = fields("review monthly starting tomorrow");

      expect(result.dateString).not.toBeNull();
      // "tomorrow" is 2026-09-03; a monthly recurrence anchored on "now"
      // (no prior due date) lands on the same day next month, never on
      // literally tomorrow.
      expect(result.date).not.toBe("2026-09-03");
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

      it("a phrase's own computed date overrides a separate, explicit date token elsewhere in the input", () => {
        // "27 Jan" is its own, independently-recognised date token
        // (nothing about it is inside the recurrence phrase's own span);
        // the recurring Task's next occurrence is still the one true due
        // date, computed from it as the anchor (due-anchored "every
        // month" preserves the 27th's own phase) rather than "27 Jan"
        // being stored as the Task's due date directly.
        const result = fields("pay rent 27 Jan every month");

        expect(result.dateString).toBe("every month");
        expect(result.date).toBe("2027-02-27");
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
      const result = fields("buy milk p1 %Shopping", { smartDates: false });

      expect(result.priority).toBe(4);
      expect(result.labelNames).toEqual(["Shopping"]);
      expect(result.content).toBe("buy milk");
    });
  });
});
