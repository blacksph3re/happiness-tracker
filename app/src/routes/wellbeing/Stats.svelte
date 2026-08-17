<script>
  import * as echarts from 'echarts'
  import { chart as chartAction } from '../../lib/chart-action.js'
  import {
    PALETTE,
    baseOptions,
    boxOptions,
    lineOptions,
    radarOptions,
    scatterOptions,
    totalsOptions,
  } from '../../lib/chart-options.js'
  import { fiveNumberSummary, movingAverage, tallyChoices, tallyPairs } from '../../lib/series.js'
  import { plotWindow } from '../../lib/timeline.js'
  import {
    ensureAnswers,
    ensurePreferences,
    preferenceSection,
    ensureVariables,
    persistPreferences,
  } from '../../lib/store.js'
  import { dayLabel } from '../../lib/day.js'

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
    ['totals', 'Totals'],
  ]

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

  // Every view but Totals plots a scale, so a catalogue of nothing but enum
  // questions can only offer that one. Counting answers needs no scale.
  const views = $derived(
    numeric.length > 0 ? VIEWS : VIEWS.filter(([key]) => key === 'totals')
  )

  /**
   * The view actually being drawn, which is not always the one stored.
   *
   * Derived rather than clamped back into `view`, for the same reason
   * `windowLength` is: an effect that writes the state it reads is the loop
   * this app has already shipped once, and a stored "Over time" should come
   * back on its own if the account later answers something with a scale,
   * rather than being permanently rewritten by one visit.
   */
  const activeView = $derived(views.some(([key]) => key === view) ? view : 'totals')

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
    chosen = new Set(axes.filter((v) => v.origin === 'asked').map((v) => v.key))

    const stored = preferenceSection(await ensurePreferences(), 'stats')
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
    if (ready) persistPreferences('stats', current)
  })

  /** Map a variable to {day: value}, merging every question id behind it. */
  function seriesFor(variable, within = days) {
    const ids = new Set(variable.question_ids)
    const inWindow = within instanceof Set ? within : new Set(within)
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
  /**
   * The window actually in force, never longer than there are days to fill it.
   *
   * Derived rather than clamped back into `windowDays`, for two reasons: a
   * `$effect` that writes the state it reads is the loop this app has already
   * shipped once, and the stored preference is worth keeping intact — a saved
   * 30 means "a month" and should widen back out on its own as days arrive,
   * rather than being permanently rewritten to 1 by a first visit.
   */
  const windowLength = $derived(Math.min(windowDays, maxWindow))
  const maxOffset = $derived(Math.max(allDays.length - windowLength, 0))
  // Averaging over more than a third of the window flattens it to a straight
  // line, which tells the reader nothing.
  const maxSmoothing = $derived(Math.max(Math.floor(windowLength / 3), 1))

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

  const days = $derived.by(() => {
    if (allDays.length === 0) return []
    const end = allDays.length - Math.min(offset, maxOffset)
    const window = allDays.slice(Math.max(end - windowLength, 0), end)
    if (activeFilters.length === 0) return window
    // Every active dimension has to admit the day, so narrowing one never
    // widens the result.
    return window.filter((day) =>
      activeFilters.every(([key, values]) => values.has(facetTags[key]?.[day]))
    )
  })

  // Half a span, which is how far past each edge a centred average has to see —
  // counted in readings, not in calendar days. See `plotWindow`.
  const smoothingPad = $derived(smoothing > 1 ? Math.floor((smoothing - 1) / 2) : 0)

  /** Whether the filters in force admit a day at all. */
  const admits = $derived(
    (day) => activeFilters.every(([key, values]) => values.has(facetTags[key]?.[day]))
  )

  /**
   * The axis, and the run of readings the average is taken over.
   *
   * `days` holds only the days that carry answers, which is what the other
   * views and the counters want. The line needs the days between them as well,
   * so a fortnight of not answering keeps its width — but only the days the
   * filters are asking about, or an average over "Saturdays" is really an
   * average over one Saturday and six days it was told to ignore.
   */
  const timeline = $derived(
    plotWindow({ days, allDays, admits, pad: smoothingPad })
  )

  const timelineDays = $derived(timeline.shown)
  const paddedTimeline = $derived(timeline.padded)

  /** Which days the average may draw on: everything the padded run holds. */
  const smoothingReach = $derived(new Set(paddedTimeline))

  $effect(() => {
    if (smoothing > maxSmoothing) smoothing = maxSmoothing
  })

  const windowLabel = $derived(
    days.length ? `${dayLabel(days[0])} → ${dayLabel(days.at(-1))}` : 'No days in range'
  )

  /** Shared ECharts options: dusk palette, muted gridlines, no chrome. */
  // What each view needs, prepared here and rendered by `chart-options`.

  const lineSeries = $derived(
    plotted.map((variable) => {
      const points = seriesFor(variable, smoothingReach)
      // Untracked days sit in the array as nulls, so they take up their real
      // width on the axis while the line still spans them. The array runs past
      // both edges so the average at each edge is a whole one, and the padding
      // is trimmed again here.
      const raw = paddedTimeline.map((day) => points[day] ?? null)
      const averaged = movingAverage(raw, smoothing)
      return {
        name: variable.label,
        // Trimmed by what was actually added, which is not always half a span:
        // at the start of the history there is nothing before the first day to
        // pad with, and slicing a fixed amount off cut into the data instead.
        data: averaged.slice(timeline.lead, averaged.length - timeline.tail),
      }
    })
  )

  const radarShape = $derived({
    indicators: plotted.map((variable) => ({
      name: variable.label,
      max: variable.max_value ?? 5,
      min: variable.min_value ?? 0,
    })),
    averages: plotted.map((variable) => {
      const values = Object.values(seriesFor(variable))
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
    }),
  })

  const scatterPair = $derived.by(() => {
    const x = axisChoices.find((v) => v.key === scatterX)
    const y = axisChoices.find((v) => v.key === scatterY)
    if (!x || !y) return null
    return { x, y, ...tallyPairs(days, axisValues(x), axisValues(y)) }
  })

  const boxSummaries = $derived({
    labels: plotted.map((variable) => variable.label),
    summaries: plotted.map((variable) =>
      fiveNumberSummary(Object.values(seriesFor(variable)))
    ),
  })

  // Every discrete or enum question the account has answered, one bar plot
  // each - unlike the other views this ignores the "Variables" picker, since
  // "one plot for every question" is the whole point of Totals. A continuous
  // question has no small set of answers to bar, so it never appears here.
  const totalsVariables = $derived(
    variables.filter(
      (variable) =>
        variable.origin === 'asked' &&
        (variable.kind === 'discrete' || variable.kind === 'enum') &&
        facetChoices(variable).length > 0
    )
  )

  const totalsPlots = $derived(
    totalsVariables.map((variable) => {
      const choices = facetChoices(variable)
      const counts = tallyChoices(days, facetByDay(variable), choices)
      return { variable, options: totalsOptions({ choices, counts }) }
    })
  )

  const options = $derived.by(() => {
    if (activeView === 'radar') return radarOptions(radarShape)
    if (activeView === 'scatter') {
      return scatterPair ? scatterOptions(scatterPair) : baseOptions()
    }
    if (activeView === 'box') return boxOptions(boxSummaries)
    return lineOptions({
      days: timelineDays,
      series: lineSeries,
      showSymbols: smoothing === 1 && timelineDays.length < 60,
      smoothed: smoothing > 1,
    })
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
    <p class="meta">{allDays.length} {allDays.length === 1 ? 'day' : 'days'} recorded</p>
    <h1 class="mt-1 text-3xl font-bold tracking-tight">Patterns</h1>
  </header>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else if numeric.length === 0 && totalsVariables.length === 0}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h2 class="text-xl font-bold">Nothing to plot yet</h2>
      <p class="mt-2 text-haze">Answer a few days and your patterns will appear here.</p>
    </div>
  {:else}
    <div class="mb-4 flex flex-wrap gap-2">
      {#each views as [key, label] (key)}
        <button
          class="meta rounded-md border px-4 py-2 transition
                 {activeView === key
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
          {#if activeView === 'totals'}
            Show · {totalsVariables.length}
            {totalsVariables.length === 1 ? 'question' : 'questions'}
          {:else}
            Show · {plotted.length} of {numeric.length}
          {/if}
          {#if activeFilters.length > 0}
            · {days.length} of {allDays.length} days
          {/if}
        </span>
        <span class="meta">{showOpen ? 'Hide' : 'Change'}</span>
      </button>

      {#if showOpen}
        <div class="border-t border-white/10 p-4">
          {#if activeView !== 'totals'}
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
                         {variable.origin === 'asked' ? '' : 'italic'}"
                  aria-pressed={chosen.has(variable.key)}
                  onclick={() => toggle(variable.key)}
                >
                  {variable.label}
                </button>
              {/each}
            </div>
          {/if}

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

      <div class="mt-4 grid gap-4 {activeView === 'line' ? 'sm:grid-cols-2' : ''}">
        <label class="flex flex-col gap-2">
          <span class="meta">
            Length · {windowLength} {windowLength === 1 ? 'day' : 'days'}
          </span>
          <input
            type="range"
            min="1"
            max={maxWindow}
            value={windowLength}
            oninput={(event) => (windowDays = Number(event.currentTarget.value))}
            class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep accent-ember"
          />
        </label>
        {#if activeView === 'line'}
          <label class="flex flex-col gap-2">
            <!-- Named for what it actually averages. With a filter on, the
                 seven days are seven Saturdays rather than a week, and calling
                 that a seven-day average would be the page saying something
                 that is not true of the line beside it. -->
            <span class="meta">
              Smoothing · {smoothing === 1
                ? 'every answer'
                : activeFilters.length
                  ? `${smoothing} kept days averaged`
                  : `${smoothing}-day average`}
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

    {#if activeView === 'scatter'}
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

    {#if activeView === 'totals'}
      {#if totalsPlots.length === 0}
        <div class="flex h-[26rem] items-center justify-center rounded-xl border border-white/10
                    bg-ink-soft px-6 text-center">
          <p class="text-haze">No discrete or enum questions to total yet.</p>
        </div>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2">
          {#each totalsPlots as plot (plot.variable.key)}
            <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
              <p class="meta mb-2 truncate normal-case text-paper" title={plot.variable.label}>
                {plot.variable.label}
              </p>
              <div
                use:chartAction={plot.options}
                class="h-64 w-full"
                data-totals-chart
                data-question={plot.variable.key}
              ></div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if plotted.length === 0 && activeView !== 'scatter'}
      <div class="flex h-[26rem] items-center justify-center rounded-xl border border-white/10
                  bg-ink-soft px-6 text-center">
        <p class="text-haze">Choose a variable above to plot it.</p>
      </div>
    {:else}
      <div
        bind:this={chartEl}
        class="h-[26rem] w-full rounded-xl border border-white/10 bg-ink-soft p-2"
      ></div>

      {#if activeView === 'box'}
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
