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
