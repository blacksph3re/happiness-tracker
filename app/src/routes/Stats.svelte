<script>
  import * as echarts from 'echarts'
  import {
    ensureAnswers,
    ensurePreferences,
    ensureVariables,
    persistPreferences,
  } from '../lib/store.js'
  import { dayLabel, shiftDay } from '../lib/day.js'

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
  // One selection set per filterable variable, keyed by variable key. Empty or
  // absent means that dimension is not narrowing anything. Dimensions combine
  // with AND, choices inside a dimension with OR: weekends AND winter.
  let filters = $state({})
  // The panel lists every variable plus the enum filter, so it is tall. It
  // stays shut until the reader wants to change what is plotted.
  let showOpen = $state(false)
  let ready = $state(false)

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
  // Auto-tracked variables exist only to narrow the data. Scaled ones (year,
  // hour) are offered as chips over the values actually recorded, which keeps
  // day-of-year - 366 distinct values - out of a control nobody could use.
  const CHIP_LIMIT = 31
  const filterable = $derived(
    [...groupings, ...variables.filter((v) => v.roles.includes('filter'))].filter(
      (variable) => facetChoices(variable).length > 1
    )
  )
  // A scatter axis can be categorical, so enum variables belong here even
  // though they can never carry a line, a radar spoke or a box.
  const axisChoices = $derived([...numeric, ...groupings])
  const plotted = $derived(numeric.filter((v) => chosen.has(v.key)))

  $effect(() => {
    load()
  })

  /** Load the plottable variables and the raw answers behind them. */
  async function load() {
    variables = (await ensureVariables()) ?? []
    rows = (await ensureAnswers()) ?? []
    const axes = variables.filter((v) => v.roles.includes('axis'))
    scatterX = axes[0]?.key ?? ''
    scatterY = axes[1]?.key ?? axes[0]?.key ?? ''
    chosen = new Set(axes.filter((v) => !v.system_key).map((v) => v.key))

    const stored = (await ensurePreferences()) ?? {}
    if (stored.view) view = stored.view
    if (Array.isArray(stored.chosen)) chosen = new Set(stored.chosen)
    if (Number.isFinite(stored.windowDays)) windowDays = stored.windowDays
    if (Number.isFinite(stored.smoothing)) smoothing = stored.smoothing
    if (stored.filters && typeof stored.filters === 'object') {
      filters = Object.fromEntries(
        Object.entries(stored.filters)
          .filter(([, values]) => Array.isArray(values) && values.length)
          .map(([key, values]) => [key, new Set(values)])
      )
    }
    if (stored.scatterX) scatterX = stored.scatterX
    if (stored.scatterY) scatterY = stored.scatterY

    loading = false
    ready = true
  }

  /** The view state worth remembering, in a stable shape for comparison. */
  function snapshot() {
    return {
      view,
      chosen: [...chosen].sort(),
      windowDays,
      smoothing,
      filters: Object.fromEntries(
        Object.entries(filters)
          .map(([key, values]) => [key, [...values].sort()])
          .sort(([a], [b]) => (a < b ? -1 : 1))
      ),
      scatterX,
      scatterY,
    }
  }

  $effect(() => {
    // Reading the snapshot is what subscribes this effect to each control.
    const current = snapshot()
    // The store drops a save that matches what is already stored, so arriving
    // on this page and applying the state it just loaded writes nothing.
    if (ready) persistPreferences(current)
  })

  /** Map a variable to {day: value}, merging every question id behind it. */
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

  /** Values for plotting `variable`, mapping enum options onto their position. */
  function axisValues(variable) {
    if (variable.kind !== 'enum') return seriesFor(variable)
    const positions = new Map(variable.options.map((option, index) => [option.id, index]))
    const inWindow = new Set(days)
    const ids = new Set(variable.question_ids)
    const out = {}
    for (const row of rows) {
      if (!ids.has(row.question_id) || row.option_id == null) continue
      if (!inWindow.has(row.day)) continue
      if (positions.has(row.option_id)) out[row.day] = positions.get(row.option_id)
    }
    return out
  }

  /** Axis configuration, categorical for enum variables and linear otherwise. */
  function axisFor(variable, extra) {
    const shared = {
      nameLocation: 'middle',
      splitLine: { lineStyle: { color: '#2a2440' } },
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

  /** The selectable values of a filter dimension, as {id, label} pairs. */
  function facetChoices(variable) {
    if (variable.kind === 'enum') {
      return variable.options.map((option) => ({ id: option.id, label: option.label }))
    }
    const ids = new Set(variable.question_ids)
    const seen = new Set()
    for (const row of rows) {
      if (ids.has(row.question_id) && row.value != null) seen.add(row.value)
    }
    if (seen.size > CHIP_LIMIT) return []
    return [...seen]
      .sort((a, b) => a - b)
      .map((value) => ({ id: value, label: String(value) }))
  }

  /** Map each day to the value this variable recorded for it. */
  function facetByDay(variable) {
    const ids = new Set(variable.question_ids)
    const out = {}
    for (const row of rows) {
      if (!ids.has(row.question_id)) continue
      const tag = row.option_id ?? row.value
      if (tag != null) out[row.day] = tag
    }
    return out
  }

  // Precomputed once per filter dimension rather than per day.
  const facetTags = $derived(
    Object.fromEntries(
      filterable.map((variable) => [variable.key, facetByDay(variable)])
    )
  )

  /** Add or remove one choice from one filter dimension. */
  function toggleFilter(key, choiceId) {
    const next = new Set(filters[key] ?? [])
    if (next.has(choiceId)) next.delete(choiceId)
    else next.add(choiceId)
    const updated = { ...filters }
    if (next.size === 0) delete updated[key]
    else updated[key] = next
    filters = updated
  }

  const activeFilters = $derived(
    Object.entries(filters).filter(([, values]) => values.size > 0)
  )

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
    if (activeFilters.length === 0) return window
    // Every active dimension has to admit the day, so narrowing one never
    // widens the result.
    return window.filter((day) =>
      activeFilters.every(([key, values]) => values.has(facetTags[key]?.[day]))
    )
  })

  // `days` holds only the days that carry answers, which is what the other
  // views and the counters want. The timeline needs every calendar day in
  // between as well: without them a fortnight of not tracking collapses into a
  // single tick and the axis reads as though no time passed.
  const timelineDays = $derived.by(() => {
    if (days.length === 0) return []
    const all = []
    for (let cursor = days[0]; cursor <= days.at(-1); cursor = shiftDay(cursor, 1)) {
      all.push(cursor)
    }
    return all
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
        data: timelineDays,
        axisLine: { lineStyle: { color: '#3a3350' } },
        axisLabel: { formatter: (day) => dayLabel(day) },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a2440' } } },
      series: plotted.map((variable) => {
        const points = seriesFor(variable)
        // Untracked days sit in the array as nulls, so they take up their real
        // width on the axis while the line still spans them.
        const raw = timelineDays.map((day) => points[day] ?? null)
        return {
          name: variable.label,
          type: 'line',
          // Heavy smoothing on integer answers invents overshoot between equal
          // days, so the curve is only softened, never rounded.
          smooth: 0.2,
          // An averaged line no longer passes through the answers, so the
          // markers that would imply it does are dropped.
          showSymbol: smoothing === 1 && timelineDays.length < 60,
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
    const x = axisChoices.find((v) => v.key === scatterX)
    const y = axisChoices.find((v) => v.key === scatterY)
    if (!x || !y) return baseOptions()
    const xs = axisValues(x)
    const ys = axisValues(y)
    // Answers collide constantly on a short scale, so an unweighted scatter
    // shows "this pair happened" and hides "it happened forty times".
    const tally = new Map()
    for (const day of days) {
      if (xs[day] === undefined || ys[day] === undefined) continue
      const key = `${xs[day]}:${ys[day]}`
      const seen = tally.get(key)
      if (seen) seen[2] += 1
      else tally.set(key, [xs[day], ys[day], 1])
    }
    const points = [...tally.values()]
    const busiest = points.reduce((most, [, , count]) => Math.max(most, count), 1)
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
          // Area scales with the count, so a mark twice the area means twice
          // the days. Radius alone would exaggerate the busy coordinates.
          symbolSize: ([, , count]) => 9 + 26 * Math.sqrt(count / busiest),
          itemStyle: { opacity: 0.75 },
          data: points,
        },
      ],
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
      tooltip: {
        trigger: 'item',
        formatter: ({ dataIndex, value }) =>
          `<b>${plotted[dataIndex]?.label ?? ''}</b><br>` +
          `min ${value[1]} · q1 ${value[2]} · median ${value[3]} · ` +
          `q3 ${value[4]} · max ${value[5]}`,
      },
      legend: undefined,
      // Numbering the categories keeps the plot readable at any width; the
      // key below the chart carries the full prompts.
      xAxis: {
        type: 'category',
        data: plotted.map((_, index) => String(index + 1)),
        axisLabel: { interval: 0 },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a2440' } } },
      series: [
        {
          type: 'boxplot',
          data,
          itemStyle: { color: '#2a2440', borderWidth: 2 },
          // One colour per box, matching the key rendered under the chart.
          colorBy: 'data',
        },
      ],
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
          {#if activeFilters.length > 0}
            · {days.length} of {allDays.length} days
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

          {#if filterable.length > 0}
            <hr class="my-4 border-white/10" />
            <div class="mb-3 flex items-center justify-between gap-3">
              <p class="meta">Only days where</p>
              {#if activeFilters.length > 0}
                <button
                  class="meta underline underline-offset-4 hover:text-paper"
                  onclick={() => (filters = {})}
                >
                  Clear all
                </button>
              {/if}
            </div>

            {#each filterable as variable (variable.key)}
              <div class="mb-3">
                <p class="meta mb-2 normal-case text-paper">{variable.label}</p>
                <div class="flex flex-wrap gap-2">
                  {#each facetChoices(variable) as choice (choice.id)}
                    <button
                      class="meta rounded-md border px-3 py-2 transition
                             {filters[variable.key]?.has(choice.id)
                        ? 'border-dusk-lift bg-dusk/30 text-paper'
                        : 'border-white/15 hover:border-white/40'}"
                      aria-pressed={filters[variable.key]?.has(choice.id) ?? false}
                      onclick={() => toggleFilter(variable.key, choice.id)}
                    >
                      {choice.label}
                    </button>
                  {/each}
                </div>
              </div>
            {/each}

            <p class="meta mt-2 normal-case">
              {activeFilters.length === 0
                ? 'Nothing selected, so every day counts.'
                : `${days.length} of ${allDays.length} days match.`}
            </p>
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
      <!-- Stacked and width-constrained: a long prompt in a select must not
           push the control off a narrow screen. -->
      <div class="mb-4 grid gap-3 sm:grid-cols-2">
        <label class="meta flex min-w-0 items-center gap-2">
          X
          <select
            bind:value={scatterX}
            class="min-w-0 flex-1 truncate rounded-md border border-white/15 bg-ink-soft
                   px-2 py-2 normal-case"
          >
            {#each axisChoices as variable (variable.key)}
              <option value={variable.key}>{variable.label}</option>
            {/each}
          </select>
        </label>
        <label class="meta flex min-w-0 items-center gap-2">
          Y
          <select
            bind:value={scatterY}
            class="min-w-0 flex-1 truncate rounded-md border border-white/15 bg-ink-soft
                   px-2 py-2 normal-case"
          >
            {#each axisChoices as variable (variable.key)}
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

      {#if view === 'box'}
        <ol class="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {#each plotted as variable, index (variable.key)}
            <li class="flex min-w-0 items-baseline gap-2 text-sm">
              <span
                class="numeral inline-block w-5 shrink-0 text-right"
                style:color={PALETTE[index % PALETTE.length]}
              >
                {index + 1}
              </span>
              <span class="min-w-0 truncate text-haze" title={variable.label}>
                {variable.label}
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    {/if}
  {/if}
</section>
