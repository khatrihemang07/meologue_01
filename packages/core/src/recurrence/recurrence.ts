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
 * counts from `reference.now` — uniformly, for every frequency, `every
 * day` and `every week` included. See ./parser.ts's resolveAnchor for
 * exactly where the bang is turned into `"due"` or `"completion"`, once,
 * so nothing downstream has to re-check it.
 *
 * **That wasn't always the rule for `every day`/`every week`.** This
 * module used to force those two, specifically, to be completion-anchored
 * regardless of the bang — issue #170's own text called it "the detail
 * most descriptions get wrong," on the theory that a bare daily or weekly
 * cadence inherently means "do it again from whenever you actually did
 * it." Issue #291 retired that theory: driven live against both Todoist
 * web and Android
 * (meologue-reference/todoist/live-audit-dom/recurrence-reschedule-todoist-2026-09-14.json),
 * a daily Task there postponed forward and then completed resumes from
 * its postponed due date plus one interval, not from the completion
 * date — a Task postponed six days out and completed landed six days
 * later than completion-anchoring would have given, independently
 * confirmed on both platforms, not a rounding difference. `every!` still
 * means "count from when I actually did it," a user-typed opt-in the
 * "Custom repeat" dialog surfaces explicitly as "Based on: Scheduled
 * date / Completed date" (issue #292) — so that choice is preserved
 * exactly, and only the no-bang default for these two frequencies moved
 * to match every other frequency's own due-anchored default.
 *
 * **What #291's evidence does NOT cover, said here because the change is
 * wider than the measurement.** Both driven probes were `every day`, where
 * an interval of one day means the rule has no weekday *phase* to keep or
 * lose. The artifact generalises them to "next = max(current due, today) +
 * one interval" — but that formula is an inference from daily readings, not
 * something driven for a weekly or longer cadence, and for `every week` the
 * two do not agree. A Task due Mon 7 Sep completed Wed 16 Sep now lands on
 * **Mon 21 Sep**, keeping its Monday phase by stepping from the due date;
 * that formula would give **Wed 23 Sep**, and the retired completion anchor
 * gave the same. So this change moved the overdue-by-more-than-one-interval
 * weekly case too, which "only early completion differs" would have missed.
 *
 * Phase-keeping is very probably right — `every week` on a Monday Task
 * meaning "Mondays" is what the words say, and it is what every other
 * frequency here already does. But *probably right* is not *established*,
 * and nothing has driven Todoist's own weekly-overdue behaviour either way.
 * Tracked rather than assumed; do not promote a `SCHED-` row on it.
 *
 * **RESOLVED 2026-09-15 (issue #301): phase-keeping is what Todoist does,
 * and it is now driven rather than assumed.** Two probes on Todoist web,
 * recorded in
 * meologue-reference/todoist/live-audit-dom/recurrence-overdue-weekly-2026-09-15.json
 * and promoted to ledger row `SCHED-15`:
 *
 *     every week,    due Mon 31 Aug, completed Tue 15 Sep -> Mon 21 Sep
 *     every 2 weeks, due Mon 17 Aug, completed Tue 15 Sep -> Mon 28 Sep
 *
 * So the rule is `due + k x interval`, for the smallest k >= 1 landing
 * strictly after today — exactly what computeOccurrence already does.
 * `max(due, today) + interval` predicts Tue 22 Sep and Tue 29 Sep, and is
 * falsified for any interval longer than a day.
 *
 * **The `every 2 weeks` probe is the one that settles it, and the weekly
 * probe alone would NOT have.** For a one-week interval every Monday is an
 * occurrence, so "step whole intervals from the due date" and "land on the
 * next matching weekday" both predict Mon 21 Sep — the same fixture
 * weakness that produced the bad formula, one cadence up. At two weeks the
 * three rival rules predict three different dates, so a single reading
 * separates them.
 *
 * **Commit 6968bf4's own message is wrong about this and is corrected
 * here**, because a commit message outlives a ledger row and is where the
 * next reader will look: it says completing a repeating Task "now computes
 * `max(current due, today) + one interval`". The code it ships does not do
 * that and never did — it steps from the due date, which is why the two
 * probes above match it. The message inherited the same over-general
 * formula from the same daily-only fixture.
 *
 * Still NOT driven, and deliberately not generalised a third time: monthly
 * and longer cadences, recurrences carrying a time of day, multi-weekday
 * rules such as `every Mon, Wed`, and the whole `every!` family. Todoist
 * **Android** is also untouched by this — under the per-platform parity
 * ruling that is `AREC-01`'s question, not this one's.
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
