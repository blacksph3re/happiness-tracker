<script>
  import * as echarts from 'echarts'
  import { tryApi } from '../lib/api.js'

  let variables = $state([])
  let rows = $state([])
  let loading = $state(true)
  let view = $state('line')
  let scatterX = $state('')
  let scatterY = $state('')

  let chartEl
  let chart

  const VIEWS = [
    ['line', 'Over time'],
    ['radar', 'Shape'],
    ['scatter', 'Correlation'],
    ['box', 'Spread'],
  ]

  const PALETTE = ['#6b55b8', '#e8734a', '#6f9e8b', '#b9b3cc', '#a07ae8', '#e8b04a']

  const numeric = $derived(variables.filter((v) => v.roles.includes('axis')))

  $effect(() => {
    load()
  })

  /** Load the plottable variables and the raw answers behind them. */
  async function load() {
    variables = (await tryApi('/stats/variables')) ?? []
    rows = (await tryApi('/answers')) ?? []
    const axes = variables.filter((v) => v.roles.includes('axis'))
    scatterX = axes[0]?.key ?? ''
    scatterY = axes[1]?.key ?? axes[0]?.key ?? ''
    loading = false
  }

  /**
   * Map a variable to {day: value}, merging every question id behind it.
   *
   * @param {object} variable A variable from /api/stats/variables.
   * @returns {Record<string, number>} One value per day.
   */
  function seriesFor(variable) {
    const ids = new Set(variable.question_ids)
    const points = {}
    for (const row of rows) {
      if (!ids.has(row.question_id) || row.value == null) continue
      // Earliest recorded value wins, which keeps a mid-day catalogue switch
      // from overwriting the day's first-answer hour.
      if (points[row.day] === undefined) points[row.day] = row.value
    }
    return points
  }

  const days = $derived([...new Set(rows.map((row) => row.day))].sort())

  /** Shared ECharts options: dusk palette, muted gridlines, no chrome. */
  function baseOptions() {
    return {
      backgroundColor: 'transparent',
      color: PALETTE,
      textStyle: { color: '#b9b3cc', fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { left: 48, right: 20, top: 32, bottom: 40 },
      legend: { textStyle: { color: '#b9b3cc' }, top: 0 },
      tooltip: { trigger: 'axis' },
    }
  }

  /** Plot every numeric variable against time. */
  function lineOptions() {
    return {
      ...baseOptions(),
      xAxis: {
        type: 'category',
        data: days,
        axisLine: { lineStyle: { color: '#3a3350' } },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a2440' } } },
      series: numeric.map((variable) => {
        const points = seriesFor(variable)
        return {
          name: variable.label,
          type: 'line',
          smooth: true,
          showSymbol: days.length < 60,
          connectNulls: true,
          data: days.map((day) => points[day] ?? null),
        }
      }),
    }
  }

  /** Plot each numeric variable's average as one radar shape. */
  function radarOptions() {
    const indicators = numeric.map((variable) => ({
      name: variable.label,
      max: variable.max_value ?? 5,
      min: variable.min_value ?? 0,
    }))
    const averages = numeric.map((variable) => {
      const values = Object.values(seriesFor(variable))
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
    })
    return {
      ...baseOptions(),
      grid: undefined,
      tooltip: {},
      radar: {
        indicator: indicators,
        axisName: { color: '#b9b3cc' },
        splitLine: { lineStyle: { color: '#2a2440' } },
        splitArea: { areaStyle: { color: ['transparent'] } },
        axisLine: { lineStyle: { color: '#2a2440' } },
      },
      series: [
        {
          type: 'radar',
          data: [{ value: averages, name: 'Average', areaStyle: { opacity: 0.25 } }],
        },
      ],
    }
  }

  /** Plot the two chosen variables against each other. */
  function scatterOptions() {
    const x = variables.find((v) => v.key === scatterX)
    const y = variables.find((v) => v.key === scatterY)
    if (!x || !y) return baseOptions()
    const xs = seriesFor(x)
    const ys = seriesFor(y)
    const points = days
      .filter((day) => xs[day] !== undefined && ys[day] !== undefined)
      .map((day) => [xs[day], ys[day]])
    return {
      ...baseOptions(),
      tooltip: { trigger: 'item' },
      legend: undefined,
      xAxis: { name: x.label, splitLine: { lineStyle: { color: '#2a2440' } } },
      yAxis: { name: y.label, splitLine: { lineStyle: { color: '#2a2440' } } },
      series: [{ type: 'scatter', symbolSize: 12, data: points }],
    }
  }

  /** Plot the five-number summary of each numeric variable. */
  function boxOptions() {
    const data = numeric.map((variable) => {
      const values = Object.values(seriesFor(variable)).sort((a, b) => a - b)
      if (!values.length) return [0, 0, 0, 0, 0]
      const at = (ratio) => values[Math.floor((values.length - 1) * ratio)]
      return [values[0], at(0.25), at(0.5), at(0.75), values[values.length - 1]]
    })
    return {
      ...baseOptions(),
      tooltip: { trigger: 'item' },
      legend: undefined,
      xAxis: {
        type: 'category',
        data: numeric.map((v) => v.label),
        axisLabel: { interval: 0, rotate: 20 },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a2440' } } },
      series: [{ type: 'boxplot', data }],
    }
  }

  const options = $derived.by(() => {
    if (view === 'radar') return radarOptions()
    if (view === 'scatter') return scatterOptions()
    if (view === 'box') return boxOptions()
    return lineOptions()
  })

  $effect(() => {
    if (loading || !chartEl) return
    chart ??= echarts.init(chartEl, null, { renderer: 'canvas' })
    chart.setOption(options, true)
    const resize = () => chart?.resize()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      // ECharts keeps every instance in a module-level registry, so without an
      // explicit dispose each visit to this page pins another detached canvas.
      chart?.dispose()
      chart = undefined
    }
  })
</script>

<section class="mx-auto w-full max-w-5xl px-5 py-8">
  <header class="mb-6">
    <p class="meta">{days.length} days recorded</p>
    <h1 class="mt-1 text-3xl font-bold tracking-tight">Patterns</h1>
  </header>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else if numeric.length === 0}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h2 class="text-xl font-bold">Nothing to plot yet</h2>
      <p class="mt-2 text-haze">Answer a few days and your patterns will appear here.</p>
    </div>
  {:else}
    <div class="mb-4 flex flex-wrap gap-2">
      {#each VIEWS as [key, label] (key)}
        <button
          class="meta rounded-md border px-4 py-2 transition
                 {view === key
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          onclick={() => (view = key)}
        >
          {label}
        </button>
      {/each}
    </div>

    {#if view === 'scatter'}
      <div class="mb-4 flex flex-wrap gap-3">
        <label class="meta flex items-center gap-2">
          X
          <select bind:value={scatterX} class="rounded-md border border-white/15 bg-ink-soft px-2 py-1">
            {#each numeric as variable (variable.key)}
              <option value={variable.key}>{variable.label}</option>
            {/each}
          </select>
        </label>
        <label class="meta flex items-center gap-2">
          Y
          <select bind:value={scatterY} class="rounded-md border border-white/15 bg-ink-soft px-2 py-1">
            {#each numeric as variable (variable.key)}
              <option value={variable.key}>{variable.label}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}

    <div
      bind:this={chartEl}
      class="h-[26rem] w-full rounded-xl border border-white/10 bg-ink-soft p-2"
    ></div>
  {/if}
</section>
