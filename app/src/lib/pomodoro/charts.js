import { baseOptions } from '../chart-options.js'

/**
 * The week: how long each day ran, split into focus and break, and how often.
 *
 * The bars are **time**, stacked, because that is the only way "how much break
 * did I take" is a readable quantity — stacking a *count* of breaks on a count
 * of pomodoros would just draw every column twice, since a completed pomodoro
 * always has one.
 *
 * The count keeps its own axis as a line, because the two answer different
 * questions: six short pomodoros and three long ones are the same hours and a
 * different rhythm, and only seeing both together says which kind of week it
 * was.
 *
 * Colours match what the rest of the section draws for the same things:
 * `flame-lift` for focus, `sage` for a break, and a neutral line for the count
 * so it reads as a reference rather than as a third quantity.
 *
 * @param {{labels: Array<string>, counts: Array<number>, focus: Array<number>,
 *   breaks: Array<number>}} data Hours for the bars, whole pomodoros for the line.
 * @returns {object} An ECharts option object.
 */
export function weekOptions({ labels, counts, focus, breaks }) {
  return {
    ...baseOptions(),
    tooltip: {
      trigger: 'axis',
      // Hours to two places would read as a decimal nobody thinks in; this is
      // the one place the chart says what a bar is worth, so it says it in the
      // same units as every other duration in the app.
      valueFormatter: (value, index) =>
        index === 2 ? `${value}` : `${Math.floor(value)}h ${Math.round((value % 1) * 60)}m`,
    },
    legend: {
      data: ['Focus', 'Break', 'Pomodoros'],
      textStyle: { color: '#b9b3cc' },
      top: 0,
    },
    grid: { left: 48, right: 48, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#b9b3cc' } },
    yAxis: [
      {
        type: 'value',
        axisLabel: { color: '#b9b3cc', formatter: '{value}h' },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      },
      {
        type: 'value',
        // Whole pomodoros only: half of one is not a thing that happened.
        minInterval: 1,
        axisLabel: { color: '#b9b3cc' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Focus',
        type: 'bar',
        stack: 'time',
        data: focus,
        // Capped, or a week with one day in it draws a bar the width of the
        // chart — which reads as a full week rather than as a Monday.
        barMaxWidth: 48,
        itemStyle: { color: '#f2a462' },
      },
      {
        name: 'Break',
        type: 'bar',
        stack: 'time',
        data: breaks,
        barMaxWidth: 48,
        itemStyle: { color: '#6f9e8b', borderRadius: [3, 3, 0, 0] },
      },
      {
        name: 'Pomodoros',
        type: 'line',
        yAxisIndex: 1,
        data: counts,
        smooth: false,
        symbolSize: 6,
        lineStyle: { color: '#b9b3cc' },
        itemStyle: { color: '#b9b3cc' },
      },
    ],
  }
}
