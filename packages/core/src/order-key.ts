/**
 * Fractional indexing for sibling order (ADR 0050) — a Task's `orderKey`
 * sorts under plain lexicographic string comparison, with no numeric
 * column and no Server involved in deciding order at all.
 *
 * Why not integer positions, which is the obvious design: an integer
 * position means dragging one Task rewrites every sibling's position
 * below the insertion point — one drag, N rows — through a migrator
 * (../sqlite/migrator.ts) that has no transactions, so a process that dies
 * mid-drag can leave siblings with a position that skips, repeats, or
 * disagrees with what's on screen. Worse, two Devices dragging the same
 * list while offline each rewrite a run of integer positions locally;
 * when both sync, those rewrites land on the same rows and resolve
 * row-by-row under last-write-wins (ADR 0028) — the merged order is
 * whatever interleaving last-write-wins happened to produce, not the
 * order either Device actually dragged to. Fractional indexing turns a
 * drag into a write of exactly one row (the dragged Task's own), so two
 * Devices dragging *different* Tasks offline never touch each other's
 * rows at all, and sync has nothing to merge beyond the one row each
 * Device changed (see ../task-convergence.test.ts).
 *
 * The alphabet is ordered so that string index order and UTF-16 code-unit
 * order agree: digits (0x30-0x39), then uppercase (0x41-0x5A), then
 * lowercase (0x61-0x7A) — each block internally consecutive and the
 * blocks already in ascending code-unit order, so comparing two keys as
 * plain strings is exactly comparing them as base-62 values over this
 * alphabet.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length;

// How many random characters orderKeyBetween appends after the digits
// that actually separate `before` and `after`. This is the whole
// mechanism that stops two Devices reordering offline from colliding:
// both computing orderKeyBetween(before, after) for the *same* gap will
// derive the same non-jittered digits (see keyBetween below — it's a
// pure function of before/after, so two Devices with the same neighbours
// compute the same prefix), and it's the jitter after that prefix that
// makes the two Devices' keys different from each other rather than
// identical. Under SQLite upsert-by-id last-write-wins (ADR 0028), an
// identical key from two Devices wouldn't corrupt anything by itself —
// order_key isn't unique — but it would leave both Tasks tied at exactly
// the same position, breaking the "every Device applies the same
// comparator and agrees" guarantee compareByOrder exists to give,
// because a tie's tie-break (id) has nothing to do with either Device's
// actual drag. Four characters keeps the collision chance
// (1/62^4, ~1 in 14.8 million) negligible without needlessly bloating
// every key generated, including the overwhelming majority where no
// other Device is contending for the same gap at all.
const JITTER_LENGTH = 4;

// A safety valve, not a real limit: keyBetween below only recurses this
// deep when `before` and `after` share this many leading digits with
// nothing separating them, which — for keys this module actually
// generates — only happens astronomically rarely (jitter, above, is
// exactly what keeps two keys from ending up in that relationship to
// begin with). It exists so a malformed or adversarial (before, after)
// pair fails loudly with an error rather than spinning forever; see
// keyBetween's own comment for the one input shape that's genuinely
// impossible to split (not just improbable) under this scheme.
const MAX_PRECISION = 128;

/**
 * A key sorting strictly between `before` and `after` under plain
 * lexicographic comparison. `(null, null)` is the first key in an empty
 * list; `(null, x)` prepends (sorts before every existing key); `(x,
 * null)` appends (sorts after every existing key).
 *
 * Growth is real and accepted, not fully guarded against: each call
 * appends JITTER_LENGTH characters regardless of how close `before` and
 * `after` already are, and inserting repeatedly at the *same* spot (drag
 * a Task to the very top of the list, over and over) makes each new key
 * share a longer and longer prefix with its neighbour before there's
 * room to diverge, so the digits keyBetween has to walk before it finds
 * a splitting position grow with it. Nothing here ever rebalances or
 * shortens existing keys to claw that back — the same non-transactional
 * migrator (../sqlite/migrator.ts) that ruled out integer positions also
 * rules out a background compaction pass that touches every row. A list
 * that's been reordered at the same spot thousands of times ends up with
 * long keys; it does not end up wrong.
 */
export function orderKeyBetween(before: string | null, after: string | null): string {
  return keyBetween(before, after) + randomJitter(JITTER_LENGTH);
}

/**
 * The comparator every Device applies identically: orderKey ascending,
 * then id ascending. The Server is never consulted about order — this
 * runs client-side, the same function on every Device, so two Devices
 * that have synced the same rows always render them in the same order
 * without asking anyone. The id tie-break only matters for two Tasks
 * that share an orderKey exactly (an intentional near-impossibility —
 * see JITTER_LENGTH's comment — not a case this module tries to avoid
 * happening, only to make survivable): without it, two Tasks with equal
 * orderKeys would have no defined relative order at all, and different
 * Devices' sort implementations could legally disagree on which comes
 * first.
 */
export function compareByOrder(
  a: { orderKey: string; id: string },
  b: { orderKey: string; id: string },
): number {
  if (a.orderKey !== b.orderKey) {
    return a.orderKey < b.orderKey ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

// The actual midpoint search, digit by digit, with no jitter — a pure
// function of (before, after) so that two Devices computing the same gap
// arrive at the same prefix (jitter, applied by the caller above, is what
// then makes their final keys differ).
//
// At each digit position i, `b` is `before`'s digit there (or 0 if
// `before` is null or has run out of digits — a shorter string sorts
// before a longer one that extends it, exactly as if the missing digits
// were the alphabet's smallest) and `a` is `after`'s digit there (or a
// sentinel one past the alphabet's largest digit if `after` is null,
// standing in for "no upper bound"; or 0 if `after` has run out).
//
// - If there's a genuine gap at this position (a - b >= 2), pick a digit
//   strictly between them and stop: everything before this position
//   already ties `before`/`after`, so this one differing digit alone
//   decides both comparisons and nothing after it can change that.
// - If they're adjacent (a - b === 1), this position can only match
//   `before`'s digit exactly — but that's still a legal choice, because
//   `before`'s digit is by construction one less than `after`'s here, so
//   choosing it already guarantees the result sorts below `after` no
//   matter what gets appended later. What it does *not* yet guarantee is
//   sorting above `before` (this position ties `before` exactly) — so the
//   search continues, but from here on `after` is no longer a real
//   constraint (afterExhausted flips true): the upper bound was already
//   secured at this position.
// - If they're equal (a === b), neither bound is decided yet at this
//   position; copy the digit and go one position deeper for more
//   precision.
function keyBetween(before: string | null, after: string | null): string {
  const beforeDigits = before === null ? null : digitsOf(before);
  const afterDigits = after === null ? null : digitsOf(after);
  const result: number[] = [];
  // Once true, `after` has already been satisfied by an earlier digit —
  // see the "adjacent" branch below — and every later position treats the
  // upper bound as unconstrained (BASE, i.e. "no digit here is too high").
  let afterExhausted = after === null;

  for (let i = 0; i < MAX_PRECISION; i++) {
    const b = digitAt(beforeDigits, i);
    const a = afterExhausted ? BASE : digitAt(afterDigits, i);

    if (a - b >= 2) {
      result.push(b + Math.floor((a - b) / 2));
      return stringOfDigits(result);
    }
    if (a - b === 1) {
      result.push(b);
      afterExhausted = true;
      continue;
    }
    // a === b: still tied on both bounds. The one input shape this can
    // never resolve is `after` being exactly `before` with the alphabet's
    // minimum digit ('0') appended one or more times — there is
    // genuinely no string between "15" and "150" under this scheme (any
    // candidate has to extend "15", and the only digit not exceeding
    // "150" at that next position is '0' itself, which reproduces "150"
    // rather than falling short of it). MAX_PRECISION turns that
    // impossible case into a thrown error instead of an infinite loop;
    // it is not expected to trigger for keys this module generates,
    // because JITTER_LENGTH's random suffix is exactly what keeps a
    // generated key from ever landing in that exact relationship with
    // its neighbour.
    result.push(b);
  }

  throw new Error(
    `orderKeyBetween: no room between ${before ?? "(start)"} and ${after ?? "(end)"} within ${MAX_PRECISION} digits`,
  );
}

// `digits` is null when the corresponding bound (`before`/`after`) is
// null, and out-of-range once `i` runs past a real key's own digits —
// both cases mean "no digit constrains this position," which is exactly
// what padding with the alphabet's smallest value (0) represents; see
// keyBetween's header comment for why that padding is the right stand-in
// for "shorter string sorts first."
function digitAt(digits: number[] | null, i: number): number {
  return digits?.[i] ?? 0;
}

function digitsOf(key: string): number[] {
  const digits: number[] = [];
  for (const char of key) {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) {
      throw new Error(
        `orderKeyBetween: "${key}" contains a character outside the order-key alphabet`,
      );
    }
    digits.push(digit);
  }
  return digits;
}

function stringOfDigits(digits: number[]): string {
  return digits.map((digit) => ALPHABET[digit]).join("");
}

function randomJitter(length: number): string {
  let jitter = "";
  for (let i = 0; i < length; i++) {
    // Math.random(), not crypto — jitter only has to make two Devices'
    // keys diverge in practice, not resist an adversary. Nothing about
    // order is a security boundary.
    jitter += ALPHABET[Math.floor(Math.random() * BASE)];
  }
  return jitter;
}
