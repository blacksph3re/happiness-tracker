/**
 * ECharts configuration for the stats page.
 *
 * Every builder takes data that has already been computed and returns an
 * option object. Keeping the presentation here means the page itself is about
 * which days and which variables, not about axis padding and legend paging.
 */

import { dayLabel } from './day.js'
import { themeToken } from './theme.svelte.js'

/** The series colours' tokens, in the order ECharts assigns them.
 *
 * Tokens rather than hex values, so a chart draws in the theme in force. The
 * box plot's key is rendered as markup beside the chart and names the same
 * tokens through `var()`; two copies of the colours would drift apart the
 * first time one of them changed.
 */
export const SERIES_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6']

/** The series colours, resolved for the theme in force. */
export function palette() {
  return SERIES_TOKENS.map((name) => themeToken(name))
}

/**
 * A chart's chrome, resolved for the theme in force.
 *
 * Read when a chart's options are built, and — because `themeToken` reads the
 * theme — built again when it changes, so a chart already on screen redraws.
 *
 * `web` is the radar's rings and spokes, which are brighter than every other
 * chart's gridlines on purpose. A cartesian chart carries tick labels and an
 * axis line, so a faint splitline is a hint beside things that already say
 * where a value sits. A radar has none of that: the web *is* the scale, and at
 * the gridline colour it measured **1.07:1** against the `ink-soft` card it is
 * drawn on — reported as barely readable, which is what a ratio that close to 1
 * looks like. `chart-web` is 2.21:1 in dark: present enough to read a value
 * off, and still well under the plotted shape. `charts.test.js` asserts the
 * ratio in both themes rather than the hex, or it would only be restating the
 * stylesheet back to itself.
 */
export function chrome() {
  return {
    muted: themeToken('chart-muted'),
    grid: themeToken('chart-grid'),
    axis: themeToken('chart-axis'),
    web: themeToken('chart-web'),
  }
}

/** The chrome every view shares: dusk palette, muted gridlines, scrolling legend. */
export function baseOptions() {
  return {
    backgroundColor: 'transparent',
    color: palette(),
    textStyle: { color: chrome().muted, fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { left: 48, right: 20, top: 56, bottom: 40 },
    animationDuration: 300,
    animationDurationUpdate: 300,
    animationEasingUpdate: 'cubicOut',
    legend: {
      // Question prompts are long, so the legend scrolls on one line instead
      // of wrapping into rows that overlap the plot.
      type: 'scroll',
      top: 0,
      textStyle: { color: chrome().muted },
      pageTextStyle: { color: chrome().muted },
      pageIconColor: palette()[0],
      pageIconInactiveColor: chrome().axis,
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
  const shared = {
    nameLocation: 'middle',
    splitLine: { lineStyle: { color: chrome().grid } },
    ...extra,
  }
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
      axisLine: { lineStyle: { color: chrome().axis } },
      axisLabel: { formatter: (day) => dayLabel(day) },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: chrome().grid } } },
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
      axisName: { color: chrome().muted },
      splitLine: { lineStyle: { color: chrome().web } },
      splitArea: { areaStyle: { color: ['transparent'] } },
      axisLine: { lineStyle: { color: chrome().web } },
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
    yAxis: { type: 'value', splitLine: { lineStyle: { color: chrome().grid } } },
    series: [
      {
        type: 'boxplot',
        data: summaries,
        itemStyle: { color: chrome().grid, borderWidth: 2 },
        // One colour per box, matching the key rendered under the chart.
        colorBy: 'data',
      },
    ],
  }
}

/**
 * Count how many days recorded each possible answer to one question.
 *
 * @param {{choices: Array<{label: string}>, counts: Array<number>}} input
 */
export function totalsOptions({ choices, counts }) {
  return {
    ...baseOptions(),
    legend: undefined,
    grid: { left: 36, right: 16, top: 16, bottom: choices.length > 5 ? 64 : 32 },
    tooltip: {
      trigger: 'item',
      formatter: ({ dataIndex, value }) =>
        `${choices[dataIndex]?.label ?? ''}: ${value} ${value === 1 ? 'day' : 'days'}`,
    },
    xAxis: {
      type: 'category',
      data: choices.map((choice) => choice.label),
      axisLine: { lineStyle: { color: chrome().axis } },
      axisLabel: {
        interval: 0,
        rotate: choices.length > 5 ? 30 : 0,
        formatter: (v) => (v.length > 14 ? `${v.slice(0, 13)}…` : v),
      },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: chrome().grid } },
    },
    series: [
      {
        type: 'bar',
        data: counts,
        itemStyle: { color: palette()[0] },
        barMaxWidth: 48,
      },
    ],
  }
}
