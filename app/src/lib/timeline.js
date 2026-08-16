import { shiftDay } from './day.js'

/**
 * Which days a line is drawn over, and which days its average may see.
 *
 * Two kinds of absent day, and the difference is the whole of this file:
 *
 * - A day nobody answered is a **gap**. It belongs on the axis, taking up its
 *   real width, because a fortnight of not answering is a fortnight — and
 *   collapsing it to one tick would draw a line that says otherwise.
 * - A day a filter excluded is **not being asked about**. "Only Saturdays" is a
 *   question about Saturdays, and the Tuesdays between them are not thin
 *   readings but no readings at all.
 *
 * Averaging over the second kind is what turned a smoothed line into a
 * staircase: every seven-day window held exactly one Saturday and returned that
 * Saturday's value, seven positions running, then stepped to the next one.
 * Nothing was averaged, and the control appeared to do nothing but square off
 * the corners.
 */

/**
 * The days to plot, with half a span of readings either side to average over.
 *
 * @param {{days: Array<string>, allDays: Array<string>,
 *   admits: (day: string) => boolean, pad: number}} query `days` is the window
 *   as chosen, `allDays` the whole history it was taken from, `admits` the
 *   filters in force, and `pad` how many readings an average reaches past each
 *   edge.
 * @returns {{shown: Array<string>, padded: Array<string>, lead: number,
 *   tail: number}} `shown` is the axis; `padded` is what to average over, and
 *   trimming `lead` from its front and `tail` from its back gives `shown` again.
 */
export function plotWindow({ days, allDays, admits, pad }) {
  if (days.length === 0 || allDays.length === 0) {
    return { shown: [], padded: [], lead: 0, tail: 0 }
  }

  // Every day the filters admit, across the whole history — the sequence the
  // padding is counted in. Built from the calendar rather than from the
  // answers, so an admitted day nobody answered keeps its place as a gap.
  const candidates = []
  for (
    let cursor = allDays[0];
    cursor <= allDays.at(-1);
    cursor = shiftDay(cursor, 1)
  ) {
    if (admits(cursor)) candidates.push(cursor)
  }

  const from = candidates.findIndex((day) => day >= days[0])
  const to = candidates.findLastIndex((day) => day <= days.at(-1))
  if (from === -1 || to < from) return { shown: [], padded: [], lead: 0, tail: 0 }

  // Never past the ends of the history: an average at the very first reading is
  // taken over what exists, not over days invented to make it symmetrical.
  const lead = Math.min(pad, from)
  const tail = Math.min(pad, candidates.length - 1 - to)
  return {
    shown: candidates.slice(from, to + 1),
    padded: candidates.slice(from - lead, to + 1 + tail),
    lead,
    tail,
  }
}
