<script>
  import * as echarts from 'echarts'
  import { api, tryApi } from '../lib/api.js'
  import { dayLabel } from '../lib/day.js'

  let variables = $state([])
  let rows = $state([])
  let loading = $state(true)
  let view = $state('line')
  let scatterX = $state('')
  let scatterY = $state('')
  // Real questions are plotted by default; the auto-tracked variables start
  // hidden, since weekday and day-of-year drown out everything else.
  let chosen = $state(new Set())

  // Both must be $state: the container only enters the DOM once something is
  // selected, and an untracked binding would never re-run the effects below.
  let chartEl = $state(null)
  let chart = $state(null)

  // The window is expressed as a length in days plus how far its right-hand
  // edge sits from the newest recorded day, so both sliders stay meaningful as
  // more days arrive.
  let windowDays = $state(30)
  let offset = $state(0)
  // 1 plots the answers themselves; higher spans replace each point with a
  // centred moving average, trading detail for trend.
  let smoothing = $state(1)
  let groupBy = $state('')
  let filterBy = $state('')
  let filterOptions = $state(new Set())
  // The panel lists every variable plus the enum filter, so it is tall. It
  // stays shut until the reader wants to change what is plotted.
  let showOpen = $state(false)
  let ready = $state(false)
  let saveTimer

  const VIEWS = [
    ['line', 'Over time'],
    ['radar', 'Shape'],
    ['scatter', 'Correlation'],
    ['box', 'Spread'],
  ]

  const PALETTE = ['#6b55b8', '#e8734a', '#6f9e8b', '#b9b3cc', '#a07ae8', '#e8b04a']

  const numeric = $derived(variables.filter((v) => v.roles.includes('axis')))
  // Enum answers carry no scale, so they never become an axis. They colour the
  // correlation plot and filter the timeline instead.
  const groupings = $derived(variables.filter((v) => v.roles.includes('group')))
  const plotted = $derived(numeric.filter((v) => chosen.has(v.key)))

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
    chosen = new Set(axes.filter((v) => !v.system_key).map((v) => v.key))

    const stored = (await tryApi('/me/preferences')) ?? {}
    if (stored.view) view = stored.view
    if (Array.isArray(stored.chosen)) chosen = new Set(stored.chosen)
    if (Number.isFinite(stored.windowDays)) windowDays = stored.windowDays
    if (Number.isFinite(stored.smoothing)) smoothing = stored.smoothing
    if (stored.groupBy) groupBy = stored.groupBy
    if (stored.filterBy) filterBy = stored.filterBy
    if (Array.isArray(stored.filterOptions)) filterOptions = new Set(stored.filterOptions)
    if (stored.scatterX) scatterX = stored.scatterX
    if (stored.scatterY) scatterY = stored.scatterY

    loading = false
    ready = true
  }

  /**
   * Persist the view state, coalescing the bursts a dragged slider produces
   * into one write.
   */
  function save() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      api('/me/preferences', {
        method: 'PUT',
        body: {
          view,
          chosen: [...chosen],
          windowDays,
          smoothing,
          groupBy,
          filterBy,
          filterOptions: [...filterOptions],
          scatterX,
          scatterY,
        },
      }).catch(() => {
        // View state is a convenience; a failed save must not interrupt reading.
      })
    }, 600)
  }

  $effect(() => {
    // Touch everything worth remembering so any change schedules a save.
    const snapshot = [
      view,
      [...chosen].join(),
      windowDays,
      smoothing,
      scatterX,
      scatterY,
      groupBy,
      filterBy,
      [...filterOptions].join(),
    ]
    if (ready) save(snapshot)
  })

  /**
   * Map a variable to {day: value}, merging every question id behind it.
   *
   * @param {object} variable A variable from /api/stats/variables.
   * @returns {Record<string, number>} One value per day.
   */
  function seriesFor(variable) {
    const ids = new Set(variable.question_ids)
    const inWindow = new Set(days)
    const points = {}
    for (const row of rows) {
      if (!ids.has(row.question_id) || row.value == null) continue
      if (!inWindow.has(row.day)) continue
      // Earliest recorded value wins, which keeps a mid-day catalogue switch
      // from overwriting the day's first-answer hour.
      if (points[row.day] === undefined) points[row.day] = row.value
    }
    return points
  }

  const allDays = $derived([...new Set(rows.map((row) => row.day))].sort())

  // Clamp both sliders to the data actually present.
  const maxWindow = $derived(Math.max(allDays.length, 1))
  const maxOffset = $derived(Math.max(allDays.length - windowDays, 0))
  // Averaging over more than a third of the window flattens it to a straight
  // line, which tells the reader nothing.
  const maxSmoothing = $derived(Math.max(Math.floor(windowDays / 3), 1))

  /** Map each day to the option chosen for `variable`, if any. */
  function optionByDay(variable) {
    if (!variable) return {}
    const ids = new Set(variable.question_ids)
    const out = {}
    for (const row of rows) {
      if (ids.has(row.question_id) && row.option_id != null) out[row.day] = row.option_id
    }
    return out
  }

  const filterVariable = $derived(groupings.find((v) => v.key === filterBy) ?? null)
  const groupVariable = $derived(groupings.find((v) => v.key === groupBy) ?? null)
  const filterTags = $derived(optionByDay(filterVariable))

  function movingAverage(values, span) {
    if (span <= 1) return values
    return values.map((_, index) => {
      const start = Math.max(index - Math.floor((span - 1) / 2), 0)
      const end = Math.min(start + span - 1, values.length - 1)
      let total = 0
      let counted = 0
      for (let i = start; i <= end; i += 1) {
        if (values[i] != null) {
          total += values[i]
          counted += 1
        }
      }
      return counted ? Number((total / counted).toFixed(2)) : null
    })
  }

  const days = $derived.by(() => {
    if (allDays.length === 0) return []
    const end = allDays.length - Math.min(offset, maxOffset)
    const window = allDays.slice(Math.max(end - windowDays, 0), end)
    // The filter belongs to the timeline, where its control lives. Applying it
    // everywhere would quietly reshape views that give no sign it is on.
    if (view !== 'line' || !filterVariable || filterOptions.size === 0) return window
    return window.filter((day) => filterOptions.has(filterTags[day]))
  })

  $effect(() => {
    if (smoothing > maxSmoothing) smoothing = maxSmoothing
  })

  const windowLabel = $derived(
    days.length ? `${dayLabel(days[0])} → ${dayLabel(days.at(-1))}` : 'No days in range'
  )

  /** Shared ECharts options: dusk palette, muted gridlines, no chrome. */
  function baseOptions() {
    return {
      backgroundColor: 'transparent',
      color: PALETTE,
      textStyle: { color: '#b9b3cc', fontFamily: 'Inter, system-ui, sans-serif' },
      // Question prompts are long, so the legend scrolls on one line instead of
      // wrapping into rows that overlap the plot.
      grid: { left: 48, right: 20, top: 56, bottom: 40 },
      animationDuration: 300,
      animationDurationUpdate: 300,
      animationEasingUpdate: 'cubicOut',
      legend: {
        type: 'scroll',
        top: 0,
        textStyle: { color: '#b9b3cc' },
        pageTextStyle: { color: '#b9b3cc' },
        pageIconColor: '#6b55b8',
        pageIconInactiveColor: '#3a3350',
      },
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
      series: plotted.map((variable) => {
        const points = seriesFor(variable)
        const raw = days.map((day) => points[day] ?? null)
        return {
          name: variable.label,
          type: 'line',
          // Heavy smoothing on integer answers invents overshoot between equal
          // days, so the curve is only softened, never rounded.
          smooth: 0.2,
          // An averaged line no longer passes through the answers, so the
          // markers that would imply it does are dropped.
          showSymbol: smoothing === 1 && days.length < 60,
          sampling: 'lttb',
          lineStyle: { width: smoothing > 1 ? 2.5 : 2 },
          connectNulls: true,
          data: movingAverage(raw, smoothing),
        }
      }),
    }
  }

  /** Plot each numeric variable's average as one radar shape. */
  function radarOptions() {
    const indicators = plotted.map((variable) => ({
      name: variable.label,
      max: variable.max_value ?? 5,
      min: variable.min_value ?? 0,
    }))
    const averages = plotted.map((variable) => {
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
    // Answers on a 0-5 scale collide constantly, so an unweighted scatter shows
    // "this pair happened" and hides "it happened forty times".
    // One tally per option when grouping, so each group keeps its own counts
    // and a shared size scale that stays comparable between them.
    const tags = optionByDay(groupVariable)
    const buckets = new Map()
    for (const day of days) {
      if (xs[day] === undefined || ys[day] === undefined) continue
      const group = groupVariable ? (tags[day] ?? null) : null
      if (groupVariable && group === null) continue
      const tally = buckets.get(group) ?? new Map()
      const key = `${xs[day]}:${ys[day]}`
      const seen = tally.get(key)
      if (seen) seen[2] += 1
      else tally.set(key, [xs[day], ys[day], 1])
      buckets.set(group, tally)
    }
    const busiest = [...buckets.values()].reduce(
      (most, tally) =>
        [...tally.values()].reduce((inner, [, , count]) => Math.max(inner, count), most),
      1
    )
    const sizeFor = ([, , count]) => 9 + 26 * Math.sqrt(count / busiest)
    return {
      ...baseOptions(),
      legend: undefined,
      tooltip: {
        trigger: 'item',
        formatter: (item) => {
          const [a, b, count] = item.value
          const head = groupVariable ? `<b>${item.seriesName}</b><br>` : ''
          return (
            `${head}${x.label}: ${a}<br>${y.label}: ${b}<br>` +
            `${count} ${count === 1 ? 'day' : 'days'}`
          )
        },
      },
      // Pad the axes past the scale so the largest marks are not clipped in
      // half at the extremes, where the busiest coordinates tend to sit.
      grid: { left: 64, right: 28, top: groupVariable ? 48 : 24, bottom: 64 },
      xAxis: {
        name: x.label,
        nameLocation: 'middle',
        nameGap: 34,
        min: (x.min_value ?? 0) - 0.5,
        max: (x.max_value ?? 5) + 0.5,
        // The half-step padding exists to keep marks off the edge; it is not a
        // value anyone answered, so it is not labelled.
        axisLabel: { formatter: (v) => (Number.isInteger(v) ? v : '') },
        splitLine: { lineStyle: { color: '#2a2440' } },
      },
      yAxis: {
        name: y.label,
        nameLocation: 'middle',
        nameGap: 42,
        min: (y.min_value ?? 0) - 0.5,
        max: (y.max_value ?? 5) + 0.5,
        axisLabel: { formatter: (v) => (Number.isInteger(v) ? v : '') },
        splitLine: { lineStyle: { color: '#2a2440' } },
      },
      legend: groupVariable
        ? { type: 'scroll', top: 0, textStyle: { color: '#b9b3cc' } }
        : undefined,
      series: [...buckets.entries()].map(([group, tally]) => ({
        name: groupVariable
          ? (groupVariable.options.find((o) => o.id === group)?.label ?? 'Unrecorded')
          : 'Days',
        type: 'scatter',
        // Area scales with the count, so a mark twice the area means twice the
        // days. Radius alone would exaggerate the busy coordinates.
        symbolSize: sizeFor,
        itemStyle: { opacity: 0.7 },
        data: [...tally.values()],
      })),
    }
  }

  /** Plot the five-number summary of each numeric variable. */
  function boxOptions() {
    const data = plotted.map((variable) => {
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
        data: plotted.map((v) => v.label),
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

  function toggle(key) {
    const next = new Set(chosen)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    chosen = next
  }

  // Creating and destroying the instance is kept apart from feeding it data, so
  // that toggling a variable redraws the chart instead of rebuilding it.
  $effect(() => {
    const element = chartEl
    if (!element) return
    const instance = echarts.init(element, null, { renderer: 'canvas' })
    chart = instance
    const resize = () => instance.resize()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      // ECharts keeps every instance in a module-level registry, so without an
      // explicit dispose each visit to this page pins another detached canvas.
      instance.dispose()
      chart = null
    }
  })

  $effect(() => {
    const next = options
    chart?.setOption(next, true)
  })
</script>

<section class="mx-auto w-full max-w-5xl px-5 py-8">
  <header class="mb-6">
    <p class="meta">{allDays.length} days recorded</p>
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

    <div class="mb-4 rounded-xl border border-white/10 bg-ink-soft">
      <button
        class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={showOpen}
        onclick={() => (showOpen = !showOpen)}
      >
        <span class="meta">
          Show · {plotted.length} of {numeric.length}
          {#if filterVariable && filterOptions.size > 0}
            · filtered
          {/if}
        </span>
        <span class="meta">{showOpen ? 'Hide' : 'Change'}</span>
      </button>

      {#if showOpen}
        <div class="border-t border-white/10 p-4">
          <div class="mb-3 flex items-center justify-between gap-3">
            <p class="meta">Variables</p>
            <span class="flex gap-3">
              <button
                class="meta underline underline-offset-4 hover:text-paper"
                onclick={() => (chosen = new Set(numeric.map((v) => v.key)))}
              >
                All
              </button>
              <button
                class="meta underline underline-offset-4 hover:text-paper"
                onclick={() => (chosen = new Set())}
              >
                None
              </button>
            </span>
          </div>
          <div class="flex flex-wrap gap-2">
            {#each numeric as variable (variable.key)}
              <button
                class="meta rounded-md border px-3 py-2 transition
                       {chosen.has(variable.key)
                  ? 'border-dusk-lift bg-dusk/30 text-paper'
                  : 'border-white/15 hover:border-white/40'}
                       {variable.system_key ? 'italic' : ''}"
                aria-pressed={chosen.has(variable.key)}
                onclick={() => toggle(variable.key)}
              >
                {variable.label}
              </button>
            {/each}
          </div>

          {#if groupings.length > 0 && view === 'line'}
            <hr class="my-4 border-white/10" />
            <label class="meta flex flex-wrap items-center gap-3">
              Only days where
              <select
                bind:value={filterBy}
                onchange={() => (filterOptions = new Set())}
                class="rounded-md border border-white/15 bg-ink px-3 py-2 normal-case"
              >
                <option value="">Every day counts</option>
                {#each groupings as variable (variable.key)}
                  <option value={variable.key}>{variable.label}</option>
                {/each}
              </select>
            </label>
            {#if filterVariable}
              <div class="mt-3 flex flex-wrap gap-2">
                {#each filterVariable.options as option (option.id)}
                  <button
                    class="meta rounded-md border px-3 py-2 transition
                           {filterOptions.has(option.id)
                      ? 'border-dusk-lift bg-dusk/30 text-paper'
                      : 'border-white/15 hover:border-white/40'}"
                    aria-pressed={filterOptions.has(option.id)}
                    onclick={() => {
                      const next = new Set(filterOptions)
                      if (next.has(option.id)) next.delete(option.id)
                      else next.add(option.id)
                      filterOptions = next
                    }}
                  >
                    {option.label}
                  </button>
                {/each}
                {#if filterOptions.size > 0}
                  <button
                    class="meta underline underline-offset-4 hover:text-paper"
                    onclick={() => (filterOptions = new Set())}
                  >
                    Clear
                  </button>
                {/if}
              </div>
              <p class="meta mt-2 normal-case">
                {filterOptions.size === 0
                  ? 'Nothing selected, so every day is plotted.'
                  : `${days.length} of ${allDays.length} days match.`}
              </p>
            {/if}
          {/if}

          {#if groupings.length > 0 && view === 'scatter'}
            <hr class="my-4 border-white/10" />
            <label class="meta flex flex-wrap items-center gap-3">
              Colour by
              <select
                bind:value={groupBy}
                class="rounded-md border border-white/15 bg-ink px-3 py-2 normal-case"
              >
                <option value="">Nothing — one colour for every day</option>
                {#each groupings as variable (variable.key)}
                  <option value={variable.key}>{variable.label}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      {/if}
    </div>

    <div class="mb-4 rounded-xl border border-white/10 bg-ink-soft p-4">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p class="meta">Window</p>
        <p class="meta normal-case text-paper">{windowLabel}</p>
      </div>
      <label class="flex flex-col gap-2">
        <span class="meta">
          Ends {offset === 0 ? 'at the latest day' : `${offset} days back`}
        </span>
        <input
          type="range"
          min="0"
          max={maxOffset}
          disabled={maxOffset === 0}
          bind:value={offset}
          class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep
                 accent-ember disabled:opacity-40"
        />
      </label>

      <div class="mt-4 grid gap-4 {view === 'line' ? 'sm:grid-cols-2' : ''}">
        <label class="flex flex-col gap-2">
          <span class="meta">Length · {windowDays} {windowDays === 1 ? 'day' : 'days'}</span>
          <input
            type="range"
            min="1"
            max={maxWindow}
            bind:value={windowDays}
            class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep accent-ember"
          />
        </label>
        {#if view === 'line'}
          <label class="flex flex-col gap-2">
            <span class="meta">
              Smoothing · {smoothing === 1 ? 'every answer' : `${smoothing}-day average`}
            </span>
            <input
              type="range"
              min="1"
              max={maxSmoothing}
              bind:value={smoothing}
              class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep accent-ember"
            />
          </label>
        {/if}
      </div>
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

    {#if plotted.length === 0 && view !== 'scatter'}
      <div class="flex h-[26rem] items-center justify-center rounded-xl border border-white/10
                  bg-ink-soft px-6 text-center">
        <p class="text-haze">Choose a variable above to plot it.</p>
      </div>
    {:else}
      <div
        bind:this={chartEl}
        class="h-[26rem] w-full rounded-xl border border-white/10 bg-ink-soft p-2"
      ></div>
    {/if}
  {/if}
</section>
