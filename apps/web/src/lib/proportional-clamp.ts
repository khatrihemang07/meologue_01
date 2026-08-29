/**
 * How much of each Digest gets shown when the three of them do not fit one
 * screen (#128).
 *
 * Pure arithmetic over LINES, not pixels, and that is the point: a budget in
 * pixels cuts wherever it lands, which is what produced the defect this
 * replaces — an ellipsis at the end of the second line and a sliver of a
 * third showing through underneath it. A budget in whole lines cannot leak a
 * partial one.
 *
 * The rule is "proportionally to what each needs". A long month and a
 * one-line day should not be cut to the same height: the month has more to
 * say, so it keeps more of the screen. But a card that wants less than its
 * proportional share takes only what it wants and hands the rest back,
 * rather than sitting in a box padded out to a size its prose never fills.
 */

export interface LineBudgetInput {
  /** How many lines each card's prose actually needs, in order. */
  demands: number[];
  /** Lines all of them together may occupy. */
  available: number;
  /**
   * The fewest lines a clamped card may be cut to. Below this a card stops
   * being a teaser and becomes a fragment — and the reader loses the ability
   * to tell the three Periods apart by what they say.
   */
  minimum: number;
}

/**
 * One entry per card: a line count to clamp it to, or `null` for "show all
 * of it". `null` rather than the demand itself, so a caller can tell "this
 * happens to fit" from "this was cut to exactly its own length" — only the
 * first should render without a way to read the rest.
 */
export type LineBudgets = (number | null)[];

export function allocateLineBudgets({ demands, available, minimum }: LineBudgetInput): LineBudgets {
  const total = demands.reduce((sum, demand) => sum + demand, 0);
  if (total <= available) {
    return demands.map(() => null);
  }

  const budgets: LineBudgets = demands.map(() => null);
  let remaining = available;
  let open = demands.map((_, index) => index);

  // Water-filling. A pure proportional share can never exceed a card's own
  // demand once the three together overflow — but `minimum` can, and a card
  // held at the floor while wanting less than that would sit in a box padded
  // out past its own prose, with a "read the rest" affordance under it and
  // nothing left to read. Settling those first and handing their surplus to
  // the others is what keeps the outcome independent of the order the cards
  // happen to arrive in.
  for (;;) {
    const openTotal = open.reduce((sum, index) => sum + (demands[index] ?? 0), 0);
    if (openTotal === 0) break;
    const covered = open.filter((index) => {
      const demand = demands[index] ?? 0;
      return Math.max(minimum, Math.floor((remaining * demand) / openTotal)) >= demand;
    });
    if (covered.length === 0) break;
    for (const index of covered) {
      budgets[index] = null;
      remaining -= demands[index] ?? 0;
    }
    open = open.filter((index) => !covered.includes(index));
  }

  const openTotal = open.reduce((sum, index) => sum + (demands[index] ?? 0), 0);
  for (const index of open) {
    const demand = demands[index] ?? 0;
    const share = openTotal > 0 ? (remaining * demand) / openTotal : 0;
    // Floored, never rounded: a rounded-up share is a line of space the
    // screen does not have, and three of them is the scrollbar the "they all
    // fit" branch above promised there would not be.
    budgets[index] = Math.max(minimum, Math.floor(share));
  }

  return budgets;
}
