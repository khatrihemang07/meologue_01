import { addDays, formatFloating, parseFloating } from "./calendar";
import { computeFirstOccurrence, computeNextOccurrence } from "./engine";
import { parseRecurrence } from "./parser";
import type { RecurrenceOutcome, RecurrenceReference } from "./rule";

/**
 * The recurrence engine (issue #170): a pure function of a literal
 * recurrence string and a reference date, nothing else. It never reads a
 * Task, never mutates one, and never stores anything of its own — the
 * opposite of "compute the schedule once and keep it," which is exactly
 * the design CONTEXT.md's Recurrence entry rejects: "what the user typed
 * is what is stored… the next Date is re-derived from that text each time
 * the Task is completed" — a description this module's own doc comment
 * now has to read as "each time the Task is completed, or given the
 * recurrence in the first place" (issue #191 sharpened it: re-deriving on
 * completion alone left a Task created today never due today).
 *
 * **Two questions, two functions.** ../task-store.ts's advanceRecurring
 * calls nextOccurrenceAfterCompletion below fresh on every completion,
 * passing whatever `dateString` and reference dates the Task currently
 * holds; apps/web's quick-add-task.ts calls firstOccurrence below once,
 * when a recurrence is first typed into a new or edited Task. Both are
 * thin wrappers over the identical parse step — the only difference is
 * which of ./engine.ts's two computations they hand the parsed rule to —
 * but that difference is exactly issue #191's whole point: "when is this
 * due for the first time" and "when is it next due, given it was just
 * completed" are different questions with different answers, not one
 * behaviour with a flag. There used to be a single `nextOccurrence` here
 * that only ever answered the second question; it no longer exists,
 * deliberately — a caller reaching for either name below has to decide
 * which question it's asking, rather than a third caller someday
 * inheriting whichever answer a shared function happened to give by
 * default.
 *
 * **Why `reference` is two dates, not the one the issue's own shorthand
 * ("the engine takes the string and a reference date") suggests.** A
 * due-anchored rule needs the Task's *current* due date to preserve its
 * phase (so "every 3 months" due 15 Jan keeps landing on the 15th), while
 * a completion-anchored rule needs "now" instead, and both need "now"
 * regardless as the floor below (or, for firstOccurrence, at) which no
 * occurrence is ever returned. One date can't serve both jobs at once —
 * RecurrenceReference (./rule.ts) names them `dueDate` and `now` rather
 * than collapsing them, and these functions' own signatures are the one
 * place that decomposition is spelled out, so nothing downstream has to
 * guess which date it received.
 *
 * **The two anchors.** `every` counts from `reference.dueDate`; `every!`
 * counts from `reference.now` — except `every day` and `every week`,
 * which are completion-anchored (`reference.now`) either way, bang or no
 * bang. See ./parser.ts's resolveAnchor for exactly where that exception
 * is applied, once, so nothing downstream has to re-check it.
 *
 * **Skipping missed occurrences (nextOccurrenceAfterCompletion only).**
 * Only a date strictly after `reference.now` is ever returned — a yearly
 * rule due 1 Jan 2025, not completed until 1 Jul 2026 (eighteen months
 * late), doesn't land on 1 Jan 2026 (already in the past relative to the
 * completion) but on 1 Jan 2027: two years out from the original due
 * date, not one, because ./engine.ts steps forward from the anchor one
 * full interval at a time until it clears `reference.now`, rather than
 * adding exactly one interval and stopping there. firstOccurrence has no
 * such skip to make — there is no prior occurrence to have missed when a
 * Task is only just being given the recurrence.
 *
 * A malformed or unsupported string doesn't throw — see parseRecurrence's
 * own doc comment for why a refusal is a `{ kind: "refused" }` value a
 * caller checks, the same discipline both functions' own result type
 * carries forward.
 */
export function nextOccurrenceAfterCompletion(
  dateString: string,
  reference: RecurrenceReference,
): RecurrenceOutcome {
  const parseResult = parseRecurrence(dateString);
  if (parseResult.kind === "refused") {
    return parseResult;
  }
  return computeNextOccurrence(parseResult.rule, reference);
}

/**
 * The first occurrence a recurrence produces when it's *given* to a Task,
 * rather than completed on one — inclusive of `reference.now` itself if
 * today already matches the pattern (issue #191). See this module's own
 * header comment above for the full account of why this is a distinct
 * function from nextOccurrenceAfterCompletion rather than the same one
 * with a flag, and ./engine.ts's computeFirstOccurrence for the actual
 * date arithmetic — including why "does today match" is a real question
 * for an absolute-calendar frequency like `every 3rd friday`, not simply
 * "return today."
 */
export function firstOccurrence(
  dateString: string,
  reference: RecurrenceReference,
): RecurrenceOutcome {
  const parseResult = parseRecurrence(dateString);
  if (parseResult.kind === "refused") {
    return parseResult;
  }
  return computeFirstOccurrence(parseResult.rule, reference);
}

/**
 * The calendar day after `today`'s own — always date-only (`YYYY-MM-DD`),
 * even if `today` carried a time-of-day (only its first ten characters
 * are read, the same "day-granular, not time-of-day-granular" convention
 * ../task-views.ts's today() uses `now` with). ../task-store.ts's
 * postpone is the one caller: it re-attaches whatever time-of-day the
 * *Task's own* `date` already carried itself — this function has no
 * opinion on that, deliberately, since "postpone" only ever needs to know
 * what tomorrow's calendar day is, never anything about the Task being
 * postponed.
 *
 * Lives here, not hand-rolled twice inside SqliteTaskStore and
 * InMemoryTaskStore, because "postponing an overdue task moves it to
 * tomorrow" (TaskStore.postpone's own doc comment) is calendar
 * arithmetic, and this package is where calendar arithmetic already
 * lives. Deliberately *not* built on ./engine.ts's stepping logic:
 * postpone has nothing to do with a Task's recurrence rule, or the
 * absence of one — it moves any overdue Task, recurring or not, by
 * exactly one day, full stop.
 */
export function tomorrowOf(today: string): string {
  const { epoch } = parseFloating(today);
  return formatFloating(addDays(epoch, 1), null);
}
