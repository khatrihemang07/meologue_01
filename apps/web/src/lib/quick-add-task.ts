/**
 * Turns a parsed add-field line (issue #170's quick-add parser) into the
 * fields a Task actually stores — the seam between add-task-form.tsx's
 * live parse (already reflecting whatever the reader has clicked to
 * demote — quick-add-highlight.ts) and use-tasks.ts's addTask. Kept as
 * its own pure module, free of React, so the two decisions this file
 * makes — which recognised tokens have nowhere to live yet, and how a
 * bare recurrence word becomes something ../recurrence/ can actually act
 * on — are each testable directly rather than only through a rendered
 * form.
 */
import type {
  QuickAddOptions,
  QuickAddResult,
  QuickAddToken,
  QuickAddTokenKind,
} from "@meologue/core";
import { nextOccurrence } from "@meologue/core";

/**
 * Every `QuickAddTokenKind` the parser recognises but Task
 * (../../packages/core/src/task-types.ts) has no field for yet:
 * `project`/`section` land in issue #171 by that file's own header
 * comment ("sequenced apart on purpose, so each migration's blast radius
 * is the one thing it's actually adding"), and `uncompletable`/
 * `description`/`reminder` are recognised for #170's own sake
 * (QuickAddResult's own doc comments say as much for each — `reminder`'s
 * own field comment names it explicitly: "Task has no field to persist
 * this in yet") with storage left for whichever later ticket adds it.
 * `Task.date`'s own doc comment already lists "reminders" among what a
 * Date will eventually drive, which is a forward-looking mention, not a
 * field that exists today — checked directly against task-types.ts
 * itself, not assumed from that comment's own wording.
 *
 * The point of naming them here rather than leaving them to fall out of
 * `content` silently: a recognised, non-demoted token's span is always
 * removed from `QuickAddResult.content` (../../packages/core/src/
 * quick-add/parse-quick-add.ts's `buildContent`) — correct for a field
 * this app actually stores (the reader sees the words move from the
 * Task's title into a Date badge, a priority chip, and so on), wrong for
 * one it doesn't yet, where the same removal would just delete the words
 * with nothing to show for it. That is exactly the defect this
 * programme's own standing warning names — "a Task that vanished as it
 * was typed" — so `contentKeepingUnsupported` below builds its own
 * content string that skips over these kinds' spans entirely, keeping
 * "#Shopping" or "* " as literal text the reader can still see, exactly
 * as add-task-form.tsx's own pre-#170 header comment already promised
 * every unparsed token ("typing #groceries here today creates a Task
 * literally named '#groceries'").
 *
 * **Not implemented by re-parsing with these spans added to `demoted`** —
 * an earlier version of this file did, and it had a real bug this one
 * doesn't: ../../packages/core/src/quick-add/parse-quick-add.ts's own
 * resolveOverlaps comment warns that "a demoted span simply stops
 * competing, it doesn't reserve the text as untouchable" — precisely
 * because a demoted `!5pm` reminder token's span stops blocking the
 * *separate* bare-time candidate for "5pm" inside it, that inner
 * candidate then wins as an ordinary, *supported* `time` token, and its
 * own span gets stripped from `content` anyway, leaving "buy milk !"
 * behind instead of "buy milk !5pm" (quick-add-task.test.ts's own
 * regression case for exactly this). Building content directly off the
 * token list below, rather than asking the parser to recompute one,
 * has no such trap: it only ever decides what to do with the tokens
 * `parseQuickAdd` already settled on, never asks it to settle anything a
 * second time.
 */
const UNSUPPORTED_TOKEN_KINDS: ReadonlySet<QuickAddTokenKind> = new Set([
  "project",
  "section",
  "uncompletable",
  "description",
  "reminder",
]);

/**
 * Bare recurrence words (../../packages/core/src/quick-add/en.ts's own
 * `recurrenceWords` table — this app's own English pack, this map's
 * exact seven keys) mapped onto the canonical `"every ..."` phrase
 * ../recurrence/'s parser actually accepts. The recurrence engine's own
 * grammar (../recurrence/parser.ts's `EVERY_PREFIX`) refuses anything
 * that doesn't start with the literal word "every" — deliberately, by
 * that module's own design: it owns the full grammar
 * (`every 3rd friday`, `every! 2 weeks`), and the quick-add parser
 * deliberately knows none of it, flagging only a single bare word
 * (../../packages/core/src/quick-add/date-rules.ts's own
 * matchRecurrenceWord doc comment: "this parser has no dependency on
 * that module at all"). Something has to bridge "monthly" (the eager,
 * false-positive-prone word this ticket's whole click-to-demote
 * mechanism exists for — Todoist's own "Create **monthly** report"
 * example) to "every month" (what nextOccurrence can compute a date
 * from), and it belongs on this side of the boundary, not inside either
 * module: the quick-add parser has no reason to know the recurrence
 * grammar exists, and the recurrence engine has no reason to know which
 * bare words a *different* parser flags as risky.
 *
 * This is a deliberate, honest departure from "the string is the truth
 * … what the user typed is what is stored" (170-brief.md's own words):
 * what's stored in `dateString` is the canonical phrase, not the literal
 * four-to-eleven characters the reader typed, because nothing else here
 * is a legal recurrence rule at all. The alternative — storing "monthly"
 * verbatim — would satisfy the letter of "store what was typed" while
 * producing a Task whose `dateString` `../recurrence/`'s own engine
 * refuses to compute a next date from the very first time it's
 * completed, which is a worse dishonesty than a canonical phrase that
 * actually works. `taskFieldsFromQuickAdd` still shows the reader this
 * canonical phrase back immediately (it becomes the highlighted token's
 * replacement text nowhere — see add-task-form.tsx — but is what
 * task-row.tsx/task-schedule-sheet.tsx render as the Task's recurrence
 * from that point on), so nothing about it is hidden from them.
 */
const RECURRENCE_WORD_TO_PHRASE: Readonly<Record<string, string>> = {
  daily: "every day",
  weekly: "every week",
  fortnightly: "every 2 weeks",
  biweekly: "every 2 weeks",
  monthly: "every month",
  yearly: "every year",
  annually: "every year",
};

export interface QuickAddTaskFields {
  content: string;
  date: string | null;
  deadline: string | null;
  priority: number;
  /** `../../packages/core/src/task-types.ts`'s `Task.dateString` — the canonical recurrence phrase (see `RECURRENCE_WORD_TO_PHRASE` above), or `null` for a Task that doesn't repeat. */
  dateString: string | null;
  /** `%label` names, not yet resolved to ids — use-labels.ts's `resolveLabelIds` is the async second half of turning these into `Task.labelIds`, which is why this function itself stays synchronous. */
  labelNames: string[];
}

/**
 * Mirrors ../../packages/core/src/quick-add/parse-quick-add.ts's own
 * `buildContent` algorithm — walk `tokens` in order, removing each one's
 * span from `input` and collapsing the surrounding whitespace — except a
 * token whose kind is in `UNSUPPORTED_TOKEN_KINDS` is simply skipped
 * rather than removed: the cursor never advances past it, so its own raw
 * text is carried straight through into the next appended run exactly as
 * it appears in `input`, right alongside whatever ordinary prose already
 * surrounds it.
 */
function contentKeepingUnsupported(input: string, tokens: readonly QuickAddToken[]): string {
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    if (UNSUPPORTED_TOKEN_KINDS.has(token.kind)) {
      continue;
    }
    result += input.slice(cursor, token.start);
    cursor = token.end;
  }
  result += input.slice(cursor);
  return result.replace(/\s+/g, " ").trim();
}

/** `result.tokens`' one `"recurrence"` entry, or `undefined` — there is at most one: ../../packages/core/src/quick-add/parse-quick-add.ts's greedy overlap resolution never keeps two overlapping recognised words, and this ticket's own grammar has no rule that recognises two non-overlapping recurrence words in one input as anything but two independent matches, of which only the first is read here. A second bare recurrence word elsewhere in the same line is exactly as unusual as typing "tomorrow" twice; taking the first, in reading order, is the same "first token of a kind decides" restraint task-schedule-sheet.tsx and every other single-valued field in `parseQuickAdd`'s own `buildResult` already applies (that function's "last one wins" for most fields is a different rule chosen for a different reason — see its own comment — not one this function has any reason to copy for a field `QuickAddResult` doesn't even carry a resolved value for). */
function findRecurrenceToken(tokens: readonly QuickAddToken[]): QuickAddToken | undefined {
  return tokens.find((token) => token.kind === "recurrence");
}

/**
 * The seven canonical phrases above are fixed and each independently
 * exercised by quick-add-task.test.ts against the real
 * ../../packages/core `nextOccurrence` — so a `"refused"` outcome here
 * would mean the map and the engine have drifted apart, not that this
 * particular input was bad. Treated as "not recognised" rather than
 * thrown, the same defensive posture ../../packages/core's own
 * `parseRecurrence` takes for input this module cannot fully vouch for at
 * compile time (a table lookup, unlike a type, admits no such guarantee).
 */
function resolveRecurrence(
  recurrenceToken: QuickAddToken | undefined,
  dueDate: string | null,
  now: string,
): { date: string | null; dateString: string | null } {
  if (recurrenceToken === undefined) {
    return { date: null, dateString: null };
  }
  const phrase = RECURRENCE_WORD_TO_PHRASE[recurrenceToken.raw.toLowerCase()];
  if (phrase === undefined) {
    return { date: null, dateString: null };
  }
  const outcome = nextOccurrence(phrase, { dueDate, now });
  if (outcome.kind !== "occurrence") {
    return { date: null, dateString: null };
  }
  return { date: outcome.date, dateString: phrase };
}

/**
 * Builds a Task's fields from an already-parsed add-field line. `result`
 * is expected to be whatever add-task-form.tsx's own live parse currently
 * shows on screen (quick-add-highlight.ts's `parseWithDemotions`) — its
 * `tokens` already reflect every demotion the reader has clicked, so this
 * function never has to know about that itself; it only ever decides,
 * given the tokens `parseQuickAdd` already settled on, which of them have
 * a real Task field to land in. `options.now` is `result`'s own reference
 * instant, read straight through to `resolveRecurrence` below rather than
 * re-derived, so a recognised recurrence resolves against the identical
 * "now" the rest of `result` was already computed from.
 */
export function taskFieldsFromQuickAdd(
  input: string,
  result: QuickAddResult,
  options: QuickAddOptions,
): QuickAddTaskFields {
  const recurrence = resolveRecurrence(
    findRecurrenceToken(result.tokens),
    result.date,
    options.now,
  );
  return {
    content: contentKeepingUnsupported(input, result.tokens),
    // A recognised recurrence's own computed first occurrence overrides
    // whatever plain date token (if any) also matched — "Create monthly
    // report" carries no separate date at all, so there's usually nothing
    // to override, but "monthly starting tomorrow" would otherwise leave
    // `result.date` set to "tomorrow" while `dateString` describes an
    // unrelated schedule; recurrence.date, when present, is the one true
    // due date for a Task whose `dateString` isn't null (task-types.ts's
    // own doc comment: "the string is the truth, the computed date is a
    // consequence of it").
    date: recurrence.dateString !== null ? recurrence.date : result.date,
    deadline: result.deadline,
    priority: result.priority,
    dateString: recurrence.dateString,
    labelNames: result.labelNames,
  };
}
