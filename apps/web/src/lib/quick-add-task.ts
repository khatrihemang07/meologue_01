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
  LocalDayKey,
  QuickAddOptions,
  QuickAddResult,
  QuickAddToken,
  QuickAddTokenKind,
} from "@meologue/core";
import { firstOccurrence, localDayKeyOf } from "@meologue/core";

/**
 * Every `QuickAddTokenKind` the parser recognises but this app never turns
 * into a stored field: `uncompletable`/`description`/`reminder` because
 * Task (../../packages/core/src/task-types.ts) has no field for them yet
 * (QuickAddResult's own doc comments say as much for each — `reminder`'s
 * own field comment names it explicitly: "Task has no field to persist
 * this in yet") with storage left for whichever later ticket adds it.
 * `Task.date`'s own doc comment already lists "reminders" among what a
 * Date will eventually drive, which is a forward-looking mention, not a
 * field that exists today — checked directly against task-types.ts
 * itself, not assumed from that comment's own wording.
 *
 * `deadline` sat here too, briefly, for issue #376 — Deadline had lost
 * every UI surface that could apply a parsed one, but the parser still
 * tokenised `{24 sept}` as `"deadline"`. Issue #377 removed that
 * recognition at its source instead (`{...}` is masked out of candidate
 * scanning entirely — ../../packages/core/src/quick-add/
 * parse-quick-add.ts's own `maskBracedSpans`), so there is no
 * `"deadline"` `QuickAddTokenKind` left to route through here at all;
 * `{24 sept}` never produces a token in the first place, and survives
 * into `content` for the identical reason ordinary unrecognised text
 * always has, not because this set names it.
 *
 * `project`/`section` used to sit in this set too, since issue #171
 * sequenced Project/Section storage apart from the parser itself ("each
 * migration's blast radius is the one thing it's actually adding," that
 * ticket's own header comment). Issue #370 is what finally gives them
 * somewhere to land — use-projects.ts's `resolveProjectId`/
 * `resolveSectionId`, the Project/Section-shaped siblings of
 * `resolveLabelIds` — so their spans are no longer skipped here; they're
 * stripped from `content` exactly like every other supported token,
 * the same way a recognised date or `@label` already was.
 *
 * The point of naming these three here rather than leaving them to fall
 * out of `content` silently: a recognised, non-demoted token's span
 * is always removed from `QuickAddResult.content` (../../packages/core/src/
 * quick-add/parse-quick-add.ts's `buildContent`) — correct for a field
 * this app actually stores (the reader sees the words move from the
 * Task's title into a Date badge, a priority chip, and so on), wrong for
 * one it doesn't yet, where the same removal would just delete the words
 * with nothing to show for it. That is exactly the defect this
 * programme's own standing warning names — "a Task that vanished as it
 * was typed" — so `contentKeepingUnsupported` below builds its own
 * content string that skips over these kinds' spans entirely, keeping
 * "* " or "//not yet stored" as literal text the reader can still see,
 * exactly as add-task-form.tsx's own pre-#170 header comment already
 * promised every unparsed token ("typing #groceries here today creates a
 * Task literally named '#groceries'" — true of every kind here until its
 * own ticket gave it a field, `#groceries` included, until #370).
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
 * example) to "every month" (what firstOccurrence can compute a date
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
 *
 * **A recurrence typed as a phrase (issue #188) needs no such
 * departure.** `every day`, `every 2 weeks`, `every! 3rd friday` are
 * already, verbatim, legal `../recurrence/` input — that's the whole
 * point of `date-rules.ts`'s `matchRecurrencePhrase` validating a
 * candidate against `parseRecurrence` before ever producing a token — so
 * `resolveRecurrence` below stores a phrase's own `raw` text unchanged
 * rather than looking it up in this map at all, satisfying CONTEXT.md's
 * "what the user typed … is what is stored, unchanged" more literally
 * than a bare word ever can. This map exists only to bridge the seven
 * words that aren't already legal input; a phrase never needs bridging,
 * because there is nothing left to translate.
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

/**
 * `after N days` (issue #369) — Todoist's own completion-anchored
 * shorthand, textually equivalent to `every! N days`. This is
 * `RECURRENCE_WORD_TO_PHRASE`'s own bridging job, just with a number in
 * the phrase instead of a fixed table entry: a table can't hold every N,
 * so this is a regex-shaped sibling rather than one more table row.
 * `../../packages/core/src/quick-add/date-rules.ts`'s `matchAfterDays`
 * already validated the rewritten phrase before ever producing the
 * token, so this only re-derives the identical rewrite; it never sees an
 * `N` `../recurrence/` would refuse.
 */
const AFTER_DAYS_PATTERN = /^after\s+(\d+)\s+days?$/i;

export interface QuickAddTaskFields {
  content: string;
  /** The separate Description editor's Markdown, or `null` when it was never opened/left empty. */
  description: string | null;
  date: string | null;
  priority: number;
  /** `../../packages/core/src/task-types.ts`'s `Task.dateString` — the canonical recurrence phrase (see `RECURRENCE_WORD_TO_PHRASE` above), or `null` for a Task that doesn't repeat. */
  dateString: string | null;
  /** `@label` names, not yet resolved to ids — use-labels.ts's `resolveLabelIds` is the async second half of turning these into `Task.labelIds`, which is why this function itself stays synchronous. */
  labelNames: string[];
  /**
   * A typed `#project` name, not yet resolved to an id — use-projects.ts's
   * `resolveProjectId` is the async second half (issue #370), mirroring
   * `labelNames`/`resolveLabelIds` above exactly. `null` when no `#project`
   * token was typed, the same "nothing typed" meaning `QuickAddResult.
   * projectName` already carries straight through.
   */
  projectName: string | null;
  /** The Section-shaped sibling of `projectName` — a typed `/section` name, resolved via `resolveSectionId` *within* whichever Project wins (typed or the view's own ambient one — todo-page.tsx's `handleAdd`). `null` when no `/section` token was typed. */
  sectionName: string | null;
}

/**
 * `QuickAddTaskFields`, except `priority` distinguishes "no p[1-4] token
 * was typed" from "one was" — a distinction issue #247's rename door
 * (task-title-commit.ts) needs and Quick Add's own `addTask` path never
 * did. `QuickAddResult.priority` (../../packages/core/src/quick-add/
 * types.ts's own doc comment) "Defaults to 1 … matching `Task.priority`'s
 * own default," and `storedPriorityOf` maps the degenerate `p4` onto that
 * identical stored `1` — so the resolved number alone can't tell "nothing
 * typed" apart from "p4, typed" the way a rename must: renaming a Task
 * that's already `p1` to `... p4` has to overwrite that `p1`, not read as
 * a no-op because `1` happens to equal `Task.priority`'s own untouched
 * default too.
 */
export interface QuickAddRenameFields extends Omit<QuickAddTaskFields, "priority"> {
  /** `null` when no `p[1-4]` token was typed; a stored 1-4 when one was, including the degenerate `p4` -> `1` case, which still must overwrite whatever priority the Task already had. */
  priority: number | null;
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
 * `recurrenceToken.raw` is one of `RECURRENCE_WORD_TO_PHRASE`'s seven bare
 * words, an `after N days` phrase (issue #369), or an already-canonical
 * phrase — never anything else, because a "recurrence" token only ever
 * comes from ../../packages/core/src/quick-add/date-rules.ts's
 * `matchRecurrenceWord` (a bare word, from that exact table), its
 * `matchAfterDays` (validated against the *rewritten* phrase before the
 * token was even produced — see that function's own doc comment for why
 * this and `matchRecurrencePhrase` differ there), or `matchRecurrencePhrase`
 * itself (a phrase already validated against ../../packages/core's own
 * `parseRecurrence` before the token was even produced). So the lookup
 * below either finds a bare word's canonical phrase, rewrites an `after N
 * days` match, or falls through because `raw` is a phrase already and
 * needs no translation at all (this file's own header comment on
 * `RECURRENCE_WORD_TO_PHRASE` explains why a phrase needs none) — there
 * is no fourth case where the fallthrough means "unrecognised text
 * slipped through." The canonical phrases are each independently
 * exercised by quick-add-task.test.ts against the real
 * ../../packages/core `firstOccurrence`, and every phrase either source
 * rule can produce is, by construction, something `parseRecurrence`
 * already accepted — so a `"refused"` outcome here would mean this file
 * and the tokeniser/engine have drifted apart, not that this particular
 * input was bad. Treated as "not recognised" rather than thrown
 * regardless, the same defensive posture ../../packages/core's own
 * `parseRecurrence` takes for input this module cannot fully vouch for at
 * compile time (a table lookup and a tokeniser's own guarantee, unlike a
 * type, admit no such guarantee). An `{ kind: "ended" }` outcome — a
 * phrase that parses but whose own `ending`/`for` bound has already
 * elapsed as of `now` — reads identically to a refusal here: there is no
 * next occurrence to store either way.
 */
/**
 * Exported for task-schedule-popover.tsx's own "Type a date" input
 * (issue #227) — the identical bridge described above, applied to a
 * recurrence token's `raw` text wherever one is found, not just the one
 * this file's own `findRecurrenceToken` locates. Kept as a one-line
 * function rather than re-exporting `RECURRENCE_WORD_TO_PHRASE` itself:
 * the popover has no reason to know this is a table lookup with a
 * pass-through default, only that "raw recognised text in, canonical
 * phrase ../recurrence/ accepts out" is one call.
 */
export function resolveRecurrencePhrase(raw: string): string {
  const lowered = raw.toLowerCase();
  const bareWordPhrase = RECURRENCE_WORD_TO_PHRASE[lowered];
  if (bareWordPhrase !== undefined) {
    return bareWordPhrase;
  }
  const afterDaysMatch = AFTER_DAYS_PATTERN.exec(lowered);
  const count = afterDaysMatch?.[1];
  if (count !== undefined) {
    return `every! ${count} days`;
  }
  return raw;
}

function resolveRecurrence(
  recurrenceToken: QuickAddToken | undefined,
  dueDate: string | null,
  now: LocalDayKey,
): { date: string | null; dateString: string | null } {
  if (recurrenceToken === undefined) {
    return { date: null, dateString: null };
  }
  const phrase = resolveRecurrencePhrase(recurrenceToken.raw);
  const outcome = firstOccurrence(phrase, { dueDate, now });
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
 * instant — `resolveRecurrence` below takes only the day
 * (`../../packages/core`'s `RecurrenceReference.now` stays `LocalDayKey`,
 * unaffected by issue #383's `QuickAddOptions.now` change), derived here
 * with `localDayKeyOf` rather than re-resolved, so a recognised
 * recurrence still resolves against the identical "now" the rest of
 * `result` was already computed from — just its day, since that engine
 * has no time-of-day of its own to agree or disagree with.
 */
export function taskFieldsFromQuickAdd(
  input: string,
  result: QuickAddResult,
  options: QuickAddOptions,
): QuickAddTaskFields {
  const recurrence = resolveRecurrence(
    findRecurrenceToken(result.tokens),
    result.date,
    localDayKeyOf(options.now),
  );
  return {
    content: contentKeepingUnsupported(input, result.tokens),
    description: null,
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
    priority: result.priority,
    dateString: recurrence.dateString,
    labelNames: result.labelNames,
    projectName: result.projectName,
    sectionName: result.sectionName,
  };
}

/**
 * `taskFieldsFromQuickAdd`, with `priority` corrected for a rename's own
 * use (see `QuickAddRenameFields`'s own doc comment for why the plain
 * number isn't enough): `null` when `result.tokens` holds no `"priority"`
 * entry at all, the same stored value `taskFieldsFromQuickAdd` already
 * computed otherwise. Every other field is identical — a rename resolves
 * a date, a recurrence and `@label`s exactly the way adding a
 * Task does, task-title-commit.ts's own guards are what decide whether a
 * `null` here (or on any other field) means "leave the Task's existing
 * value alone," not this function.
 */
export function taskFieldsForRename(
  input: string,
  result: QuickAddResult,
  options: QuickAddOptions,
): QuickAddRenameFields {
  const fields = taskFieldsFromQuickAdd(input, result, options);
  const priorityTyped = result.tokens.some((token) => token.kind === "priority");
  return { ...fields, priority: priorityTyped ? fields.priority : null };
}
