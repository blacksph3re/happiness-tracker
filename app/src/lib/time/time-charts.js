/**
 * ECharts configuration for the time patterns page.
 *
 * Built on the shared chrome in `chart-options.js`, so both halves of the app
 * share a palette, a font and a legend behaviour. What differs is what the
 * series mean: hours, which can overlap.
 */

import { baseOptions, chrome } from '../chart-options.js'
import { formatSigned } from '../clock.js'
import { dayLabel } from '../day.js'

/**
 * Hours per group over time, as a line.
 *
 * Thirty or ninety days of grouped bars is a picket fence: each project's bar
 * is a couple of pixels wide and the shape of the month is invisible. A line
 * per project reads at any length, and smoothing trades daily detail for the
 * trend the long windows are actually for.
 *
 * @param {{days: Array<string>, series: Array<{name: string, colour: string,
 *          data: Array<number>}>, smoothed: boolean}} input
 */
export function lineOptions({ days, series, smoothed }) {
  return {
    ...baseOptions(),
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value) => `${(value ?? 0).toFixed(2)} h`,
    },
    xAxis: {
      type: 'category',
      data: days,
      axisLine: { lineStyle: { color: chrome().axis } },
      axisLabel: { formatter: (day) => dayLabel(day) },
    },
    yAxis: {
      type: 'value',
      name: 'hours',
      nameTextStyle: { color: chrome().muted },
      splitLine: { lineStyle: { color: chrome().grid } },
    },
    series: series.map(({ name, colour, data }) => ({
      name,
      type: 'line',
      data,
      // Softened, never rounded: heavy smoothing on a day of zero invents
      // hours that were not worked.
      smooth: 0.2,
      showSymbol: !smoothed && days.length <= 31,
      sampling: 'lttb',
      lineStyle: { width: smoothed ? 2.5 : 2, color: colour },
      itemStyle: colour ? { color: colour } : undefined,
      areaStyle: smoothed ? undefined : { opacity: 0.08 },
    })),
  }
}

/**
 * Hours per group over time, one bar per group per day.
 *
 * Grouped rather than stacked, and that is not a style choice: parallel timers
 * mean a day's series can sum past 24 hours, so a stacked column would draw a
 * height that never happened and imply the sessions ran end to end.
 *
 * @param {{days: Array<string>, series: Array<{name: string, colour: string,
 *          data: Array<number>}>}} input
 */
export function barOptions({ days, series }) {
  return {
    ...baseOptions(),
    // Per bar, like the donut beside it, rather than per day: pointing at a
    // colour and being told what it is should not mean reading a list of every
    // group that day to find the one under the cursor. The axis variant also
    // only appears once the pointer is near the axis, which on a short bar felt
    // like the native tooltip it is not.
    tooltip: {
      trigger: 'item',
      // Through `dayLabel`, so the tooltip names the day the way the axis under
      // it does rather than in the raw key the category happens to be.
      formatter: ({ name, seriesName, value }) =>
        `${seriesName}<br>${dayLabel(name)} · ${(value ?? 0).toFixed(2)} h`,
    },
    xAxis: {
      type: 'category',
      data: days,
      axisLine: { lineStyle: { color: chrome().axis } },
      axisLabel: { formatter: (day) => dayLabel(day) },
    },
    yAxis: {
      type: 'value',
      name: 'hours',
      nameTextStyle: { color: chrome().muted },
      splitLine: { lineStyle: { color: chrome().grid } },
    },
    series: series.map(({ name, colour, data }) => ({
      name,
      type: 'bar',
      data,
      itemStyle: colour ? { color: colour } : undefined,
      barMaxWidth: 28,
    })),
  }
}

/**
 * The share each group holds of the total tracked time.
 *
 * @param {{slices: Array<{name: string, value: number, colour: string}>}} input
 */
export function shareOptions({ slices }) {
  return {
    ...baseOptions(),
    grid: undefined,
    tooltip: {
      trigger: 'item',
      formatter: ({ name, value, percent }) =>
        `${name}<br>${value.toFixed(2)} h · ${percent}%`,
    },
    series: [
      {
        type: 'pie',
        radius: ['45%', '72%'],
        // Centred explicitly and without leader lines: the labels outside the
        // ring were long enough to shove the whole donut off its own card, and
        // the legend above already names every slice.
        center: ['50%', '54%'],
        data: slices.map(({ name, value, colour }) => ({
          name,
          value,
          itemStyle: colour ? { color: colour } : undefined,
        })),
        label: { show: false },
        labelLine: { show: false },
      },
    ],
  }
}

/**
 * Hours by weekday, averaged over the weeks in the window.
 *
 * @param {{labels: Array<string>, series: Array<{name: string, colour: string,
 *          data: Array<number>}>}} input
 */
export function weekdayOptions({ labels, series }) {
  return {
    ...barOptions({ days: [], series }),
    // `barOptions`'s own tooltip reads `name` through `dayLabel`, which turns
    // a `YYYY-MM-DD` key into "Tue 4 Mar" — and turns "Mon" into "Invalid
    // Date", since that is what `dayLabel` does with a string that is not a
    // day key. This axis's categories are already the label, so the tooltip
    // just says it back rather than trying to parse it as one.
    tooltip: {
      trigger: 'item',
      formatter: ({ name, seriesName, value }) =>
        `${seriesName}<br>${name} · ${(value ?? 0).toFixed(2)} h`,
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: chrome().axis } },
      axisLabel: { interval: 0 },
    },
  }
}

/**
 * A budget's balance at the end of each day, as a line.
 *
 * Untracked workdays and resets are series of their own, drawn as points over
 * the line, so the drop a missed day makes and the step a reset makes are each
 * named where they happen. Never smoothed: a balance is already a running sum,
 * and averaging one draws balances nobody had.
 *
 * @param {{days: Array<string>, balance: Array<number>,
 *   untracked: Array<number|null>, resets: Array<number|null>,
 *   lines: Record<string, Array<[string, string]>>, colour: string,
 *   alarm: string}} input Hours, aligned with `days`; `lines` is each day's
 *   breakdown, for the tooltip.
 */
export function balanceOptions({ days, balance, untracked, resets, lines, colour, alarm }) {
  return {
    ...baseOptions(),
    tooltip: {
      trigger: 'axis',
      formatter: (points) => {
        const day = points[0]?.axisValue
        const at = days.indexOf(day)
        const said = [
          `<b>${dayLabel(day)}</b>`,
          `Balance ${formatSigned(Math.round(balance[at] * 3600))}`,
          ...(resets[at] !== null ? [`Budget set to ${formatSigned(Math.round(resets[at] * 3600))}`] : []),
          ...(lines[day] ?? []).map(([label, value]) => `${label} ${value}`),
        ]
        return said.join('<br>')
      },
    },
    xAxis: {
      type: 'category',
      data: days,
      axisLine: { lineStyle: { color: chrome().axis } },
      axisLabel: { formatter: (day) => dayLabel(day) },
    },
    yAxis: {
      type: 'value',
      name: 'hours',
      nameTextStyle: { color: chrome().muted },
      splitLine: { lineStyle: { color: chrome().grid } },
    },
    series: [
      {
        name: 'Balance',
        type: 'line',
        data: balance,
        showSymbol: days.length <= 31,
        lineStyle: { width: 2, color: colour },
        itemStyle: { color: colour },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: chrome().axis, type: 'solid', width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
      {
        name: 'Not tracked',
        type: 'scatter',
        data: untracked,
        symbolSize: 9,
        itemStyle: { color: alarm },
      },
      {
        name: 'Budget set',
        type: 'scatter',
        data: resets,
        symbol: 'diamond',
        symbolSize: 13,
        itemStyle: { color: colour },
      },
    ],
  }
}
