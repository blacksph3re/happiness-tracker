/**
 * ECharts configuration for the stats page.
 *
 * Every builder takes data that has already been computed and returns an
 * option object. Keeping the presentation here means the page itself is about
 * which days and which variables, not about axis padding and legend paging.
 */

import { dayLabel } from './day.js'

/** Series colours, in the order ECharts assigns them.
 *
 * Exported because the box plot's key is rendered as markup beside the chart
 * and has to match the boxes; two copies would drift apart the first time one
 * of them changed.
 */
export const PALETTE = ['#6b55b8', '#e8734a', '#6f9e8b', '#b9b3cc', '#a07ae8', '#e8b04a']

const MUTED = '#b9b3cc'
const GRIDLINE = '#2a2440'
const AXIS_LINE = '#3a3350'

/** The chrome every view shares: dusk palette, muted gridlines, scrolling legend. */
export function baseOptions() {
  return {
    backgroundColor: 'transparent',
    color: PALETTE,
    textStyle: { color: MUTED, fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { left: 48, right: 20, top: 56, bottom: 40 },
    animationDuration: 300,
    animationDurationUpdate: 300,
    animationEasingUpdate: 'cubicOut',
    legend: {
      // Question prompts are long, so the legend scrolls on one line instead
      // of wrapping into rows that overlap the plot.
      type: 'scroll',
      top: 0,
      textStyle: { color: MUTED },
      pageTextStyle: { color: MUTED },
      pageIconColor: PALETTE[0],
      pageIconInactiveColor: AXIS_LINE,
    },
    tooltip: { trigger: 'axis' },
  }
}

/**
 * An axis for one variable: categorical for an enum, linear otherwise.
 *
 * @param {object} variable The variable the axis represents.
 * @param {object} extra Axis fields merged over the shared ones.
 */
function axisFor(variable, extra) {
  const shared = { nameLocation: 'middle', splitLine: { lineStyle: { color: GRIDLINE } }, ...extra }
  if (variable.kind === 'enum') {
    return {
      ...shared,
      type: 'category',
      data: variable.options.map((option) => option.label),
      boundaryGap: true,
      // interval 0 forces every option to be labelled: dropping half of them
      // on a narrow screen hides which categories exist at all.
      axisLabel: {
        interval: 0,
        rotate: 30,
        formatter: (v) => (v.length > 14 ? `${v.slice(0, 13)}…` : v),
      },
    }
  }
  return {
    ...shared,
    type: 'value',
    min: (variable.min_value ?? 0) - 0.5,
    max: (variable.max_value ?? 5) + 0.5,
    // The half-step padding keeps marks off the edge; it is not a real value.
    axisLabel: { formatter: (v) => (Number.isInteger(v) ? v : '') },
  }
}

/**
 * Plot variables against time.
 *
 * @param {{days: Array<string>, series: Array<{name: string, data: Array<number|null>}>,
 *          showSymbols: boolean, smoothed: boolean}} input
 */
export function lineOptions({ days, series, showSymbols, smoothed }) {
  return {
    ...baseOptions(),
    xAxis: {
      type: 'category',
      data: days,
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { formatter: (day) => dayLabel(day) },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: GRIDLINE } } },
    series: series.map(({ name, data }) => ({
      name,
      type: 'line',
      // Heavy smoothing on integer answers invents overshoot between equal
      // days, so the curve is only softened, never rounded.
      smooth: 0.2,
      // An averaged line no longer passes through the answers, so the markers
      // that would imply it does are dropped.
      showSymbol: showSymbols,
      sampling: 'lttb',
      lineStyle: { width: smoothed ? 2.5 : 2 },
      connectNulls: true,
      data,
    })),
  }
}

/**
 * Plot one shape from each variable's average.
 *
 * @param {{indicators: Array<object>, averages: Array<number>}} input
 */
export function radarOptions({ indicators, averages }) {
  return {
    ...baseOptions(),
    grid: undefined,
    tooltip: {},
    radar: {
      indicator: indicators,
      axisName: { color: MUTED },
      splitLine: { lineStyle: { color: GRIDLINE } },
      splitArea: { areaStyle: { color: ['transparent'] } },
      axisLine: { lineStyle: { color: GRIDLINE } },
    },
    series: [
      {
        type: 'radar',
        data: [{ value: averages, name: 'Average', areaStyle: { opacity: 0.25 } }],
      },
    ],
  }
}

/**
 * Plot two variables against each other, sized by how often a pair recurred.
 *
 * @param {{x: object, y: object, points: Array<Array<number>>, busiest: number}} input
 */
export function scatterOptions({ x, y, points, busiest }) {
  const readable = (variable, value) =>
    variable.kind === 'enum' ? (variable.options[value]?.label ?? value) : value

  return {
    ...baseOptions(),
    legend: undefined,
    grid: { left: 64, right: 28, top: 24, bottom: x.kind === 'enum' ? 96 : 64 },
    tooltip: {
      trigger: 'item',
      formatter: ({ value: [a, b, count] }) =>
        `${x.label}: ${readable(x, a)}<br>${y.label}: ${readable(y, b)}<br>` +
        `${count} ${count === 1 ? 'day' : 'days'}`,
    },
    xAxis: axisFor(x, { name: x.label, nameGap: x.kind === 'enum' ? 62 : 34 }),
    yAxis: axisFor(y, { name: y.label, nameGap: 42 }),
    series: [
      {
        type: 'scatter',
        // Area scales with the count, so a mark twice the area means twice the
        // days. Radius alone would exaggerate the busy coordinates.
        symbolSize: ([, , count]) => 9 + 26 * Math.sqrt(count / busiest),
        itemStyle: { opacity: 0.75 },
        data: points,
      },
    ],
  }
}

/**
 * Plot the spread of each variable.
 *
 * @param {{labels: Array<string>, summaries: Array<Array<number>>}} input
 */
export function boxOptions({ labels, summaries }) {
  return {
    ...baseOptions(),
    tooltip: {
      trigger: 'item',
      formatter: ({ dataIndex, value }) =>
        `<b>${labels[dataIndex] ?? ''}</b><br>` +
        `min ${value[1]} · q1 ${value[2]} · median ${value[3]} · ` +
        `q3 ${value[4]} · max ${value[5]}`,
    },
    legend: undefined,
    // Numbering the categories keeps the plot readable at any width; the key
    // below the chart carries the full prompts.
    xAxis: {
      type: 'category',
      data: labels.map((_, index) => String(index + 1)),
      axisLabel: { interval: 0 },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: GRIDLINE } } },
    series: [
      {
        type: 'boxplot',
        data: summaries,
        itemStyle: { color: GRIDLINE, borderWidth: 2 },
        // One colour per box, matching the key rendered under the chart.
        colorBy: 'data',
      },
    ],
  }
}
