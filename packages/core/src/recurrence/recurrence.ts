import { addDays, formatFloating, parseFloating } from "./calendar";
import { computeFirstOccurrence, computeNextOccurrence } from "./engine";
import { parseRecurrence } from "./parser";
import type { RecurrenceOutcome, RecurrenceReference } from "./rule";

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
