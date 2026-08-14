/**
 * ECharts configuration for the time patterns page.
 *
 * Built on the shared chrome in `chart-options.js`, so both halves of the app
 * share a palette, a font and a legend behaviour. What differs is what the
 * series mean: hours, which can overlap.
 */

import { baseOptions } from '../chart-options.js'
import { dayLabel } from '../day.js'

const MUTED = '#b9b3cc'
const GRIDLINE = '#2a2440'
const AXIS_LINE = '#3a3350'

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
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { formatter: (day) => dayLabel(day) },
    },
    yAxis: {
      type: 'value',
      name: 'hours',
      nameTextStyle: { color: MUTED },
      splitLine: { lineStyle: { color: GRIDLINE } },
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
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value) => `${value.toFixed(2)} h`,
    },
    xAxis: {
      type: 'category',
      data: days,
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { formatter: (day) => dayLabel(day) },
    },
    yAxis: {
      type: 'value',
      name: 'hours',
      nameTextStyle: { color: MUTED },
      splitLine: { lineStyle: { color: GRIDLINE } },
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
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { interval: 0 },
    },
  }
}
