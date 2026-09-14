<script>
  import Frame from '../../lib/Frame.svelte'
  import { COLUMN } from '../../lib/wellbeing/column.js'
  import { get } from 'svelte/store'
  import * as echarts from 'echarts'
  import { chart as chartAction } from '../../lib/chart-action.js'
  import {
    boxOptions,
    lineOptions,
    radarOptions,
    scatterOptions,
    totalsOptions,
  } from '../../lib/chart-options.js'
  import {
    fiveNumberSummary,
    movingAverage,
    rankPairs,
    tallyChoices,
    tallyPairs,
  } from '../../lib/series.js'
  import { plotWindow } from '../../lib/timeline.js'
  import {
    answers as answerStore,
    catalogueDetails,
    ensureAllCatalogues,
    ensureAnswers,
    ensurePreferences,
    preferenceSection,
    ensureVariables,
    persistPreferences,
    preferences,
    ready as hydrated,
    variables as variableStore,
  } from '../../lib/store.js'
  import { dayLabel, today } from '../../lib/day.js'
  import { query } from '../../lib/router.js'
  import { habitsIn } from '../../lib/habits.js'
  import StreakGrid from '../../lib/wellbeing/StreakGrid.svelte'
  import { earliestHours, systemFacet } from '../../lib/facets.js'

  // Read from the stores rather than snapshotted out of the loader, so that a
  // background revalidation — an answer recorded on another device — redraws
  // these charts without the page having to ask for anything.
  const variables = $derived($variableStore ?? [])
  const rows = $derived($answerStore ?? [])
  let loaded = $state(false)

  // "Loading" means there is nothing to show, not that a request is out. A
  // revisit paints from the store immediately while a revalidation runs behind
  // it, which is the whole of the rule about never waiting on a fetch.
  const loading = $derived(!loaded && variables.length === 0)

  let view = $state('line')
  // Which ranked pair is open, as `x.key|y.key`. Not persisted: preferences
  // remember the shape of the view, never the position in it, and a scatter
  // left open on Tuesday is a position.
  let openPair = $state(null)
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

  /**
   * Shared days a pair needs before it is ranked rather than listed below.
   *
   * Fixed rather than a fraction of the window. Proportional sounded right and
   * is not: on a year it would demand 183 shared days, so a question added two
   * months ago ranks against nothing at all and drops off the page with nothing
   * saying why.
   */
  const MINIMUM_OVERLAP = 10

  /** A pair's identity, order-independent because a correlation has no direction. */
  const keyOf = (x, y) => [x.key, y.key].sort().join('|')

  const VIEWS = [
    ['line', 'Over time'],
    ['radar', 'Shape'],
    ['scatter', 'Correlation'],
    ['box', 'Spread'],
    ['totals', 'Totals'],
    ['streaks', 'Streaks'],
  ]

  /**
   * How many periods the streak grid draws, offered rather than free-form.
   *
   * A year was here and is not: 52 daily cells fit a phone and 52 weekly ones
   * do not, so every lane grew its own sideways scroll — a control that made the
   * page worse at the width most of it is read at. Stepping the window back is
   * what reaches further now, and it costs no width at all.
   */
  const SPANS = [12, 26]

  // In periods rather than days, and its own control rather than the window
  // above: a weekly habit inside a 30-day window is four cells, which is a
  // picture of nothing. The same reason the focus strip takes a relative axis.
  let streakSpan = $state(26)

  /**
   * How many windows back the grid is showing, zero being the one ending today.
   *
   * Stepped by whole windows rather than single periods, so Previous is the
   * same gesture as turning a page. Not persisted: a preference remembers the
   * shape of a view, never the position in it — the same reason an open scatter
   * pair is not remembered.
   */
  let streakBack = $state(0)

  // Every habit in every catalogue the account has, plus the synthetic one.
  // Read from the store rather than snapshotted out of the loader, so a target
  // changed on another device redraws these rows without a reload.
  const habits = $derived(
    Object.values($catalogueDetails).flatMap((detail) =>
      habitsIn(detail).filter((habit) => !habit.synthetic)
    )
  )
  // Daily tracking last and once, however many catalogues there are.
  const streakHabits = $derived([...habits, ...habitsIn(null)])

  // What a complete day answers, for how full a daily-tracking cell is drawn.
  const expectedPerDay = $derived(
    Object.values($catalogueDetails).reduce(
      (most, detail) =>
        Math.max(
          most,
          (detail.questions ?? []).filter(
            (question) => question.active && question.origin === 'asked'
          ).length
        ),
      0
    )
  )

  const numeric = $derived(variables.filter((v) => v.roles.includes('axis')))
  // Enum answers carry no scale, so they never become an axis. They filter the
  // timeline and partition the correlation ranking instead.
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
  const plotted = $derived(numeric.filter((v) => chosen.has(v.key)))

  // Every view but Totals plots a scale, so a catalogue of nothing but enum
  // questions can only offer that one. Counting answers needs no scale.
  const views = $derived(
    numeric.length > 0
      ? VIEWS
      : VIEWS.filter(([key]) => key === 'totals' || key === 'streaks')
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

  /**
   * Which controls the reader has already moved, so the load leaves them.
   *
   * **A choice made while the preferences read is outstanding is a real
   * choice.** `load` assigns after several awaits, so Totals picked in that
   * gap went back to Over time when the stored view landed. Per control, as on
   * the todo board. Not `$state`: it is read after an await, by code that must
   * not re-run because of it.
   */
  const steered = new Set()

  /** Load the plottable variables and the raw answers behind them. */
  async function load() {
    // The device's own copy first, so a slow start paints the remembered view
    // rather than the default; the confirmed read goes over it below.
    await hydrated()
    const held = get(preferences)
    if (held) apply(preferenceSection(held, 'stats'))
    // Awaited for the defaults below, which are chosen once from what is there
    // at the time. Neither result is assigned to component state — `variables`
    // and `rows` read the stores, and assigning here is exactly what used to
    // make a later update invisible.
    const loadedVariables = (await ensureVariables()) ?? []
    await ensureAnswers()
    // Habit definitions live on the question, in exactly one payload: two
    // copies of a definition is how the transfer button ended up
    // disagreeing with the totals above it. Not awaited into local state —
    // `habits` reads the store, so a later change redraws the rows.
    ensureAllCatalogues()
    const axes = loadedVariables.filter((v) => v.roles.includes('axis'))
    if (!steered.has('chosen') && !Array.isArray(held && preferenceSection(held, 'stats').chosen)) {
      chosen = new Set(axes.filter((v) => v.origin === 'asked').map((v) => v.key))
    }

    apply(preferenceSection(await ensurePreferences(), 'stats'))
    loaded = true
    ready = true
  }

  /**
   * Take one stored view, leaving every control the reader has already moved.
   *
   * @param {object} stored The `stats` section of the preferences document.
   */
  function apply(stored) {
    const free = (key) => !steered.has(key)
    if (free('view') && stored.view) view = stored.view
    // A view named in the URL wins over the stored one, and is applied after it
    // so arriving from a habit chip lands on the streaks whatever was last left
    // open. Read here rather than as a `$derived`: it is a starting point, not
    // a binding, so tapping another tab afterwards has to stick — which is what
    // `steered` now says.
    const asked = get(query).get('view')
    if (free('view') && asked && VIEWS.some(([key]) => key === asked)) view = asked
    if (free('chosen') && Array.isArray(stored.chosen)) chosen = new Set(stored.chosen)
    if (free('windowDays') && Number.isFinite(stored.windowDays)) windowDays = stored.windowDays
    if (free('smoothing') && Number.isFinite(stored.smoothing)) smoothing = stored.smoothing
    // A stored 52 is what an account that used the old control has; it is
    // clamped rather than ignored, so the page opens on the nearest thing
    // to what was left rather than silently on the default.
    if (free('streakSpan') && Number.isFinite(stored.streakSpan)) {
      streakSpan = SPANS.includes(stored.streakSpan)
        ? stored.streakSpan
        : SPANS.reduce((best, span) =>
            Math.abs(span - stored.streakSpan) < Math.abs(best - stored.streakSpan)
              ? span
              : best
          )
    }
    if (free('filters') && stored.filters && typeof stored.filters === 'object') {
      filters = Object.fromEntries(
        Object.entries(stored.filters)
          .filter(([, values]) => Array.isArray(values) && values.length)
          .map(([key, values]) => [key, new Set(values)])
      )
    }
  }

  /** The view state worth remembering, in a stable shape for comparison. */
  function snapshot() {
    return {
      view,
      chosen: [...chosen].sort(),
      windowDays,
      smoothing,
      streakSpan,
      filters: Object.fromEntries(
        Object.entries(filters)
          .map(([key, values]) => [key, [...values].sort()])
          .sort(([a], [b]) => (a < b ? -1 : 1))
      ),
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

  // The earliest hour each day recorded, which is all `first_answer_hour` is:
  // nothing stores it any more, and a minimum cannot depend on arrival order.
  const hoursByDay = $derived(earliestHours(rows))

  /** Axis configuration, categorical for enum variables and linear otherwise. */
  function facetChoices(variable) {
    if (variable.kind === 'enum') {
      return variable.options.map((option) => ({ id: option.id, label: option.label }))
    }
    const seen = new Set(
      variable.system_key
        ? Object.values(facetByDay(variable))
        : rows
            .filter(
              (row) => variable.question_ids.includes(row.question_id) && row.value != null
            )
            .map((row) => row.value)
    )
    if (seen.size > CHIP_LIMIT) return []
    return [...seen]
      .sort((a, b) => a - b)
      .map((value) => ({ id: value, label: String(value) }))
  }

  /** Map each day to the value this variable recorded for it. */
  function facetByDay(variable) {
    // Auto-tracked variables have no rows behind them: four are functions of
    // the day key and the fifth is the day's earliest hour.
    if (variable.system_key) {
      return systemFacet(variable.system_key, allDays, hoursByDay)?.byDay ?? {}
    }
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
    steered.add('filters')
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

  /**
   * Every pair of scaled variables, strongest first.
   *
   * Enum variables are deliberately absent. `axisValues` maps an enum answer to
   * its option's *position in the list*, which is a display order somebody
   * dragged into place — a coefficient against it changes when the options are
   * reordered. They earn their place here as filters instead: `days` is already
   * the facet-filtered window, so narrowing to weekends recomputes every
   * coefficient over weekends, which is the more honest thing to do with a
   * category.
   */
  const ranked = $derived(
    rankPairs(numeric, axisValues, days, { minimumOverlap: MINIMUM_OVERLAP })
  )

  /** The pair whose scatter is open, with its points, or null when none is. */
  const openPairPlot = $derived.by(() => {
    const pair = ranked.find(({ x, y }) => keyOf(x, y) === openPair)
    if (!pair) return null
    return {
      pair,
      options: scatterOptions({
        x: pair.x,
        y: pair.y,
        ...tallyPairs(days, axisValues(pair.x), axisValues(pair.y)),
      }),
    }
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
    if (activeView === 'box') return boxOptions(boxSummaries)
    return lineOptions({
      days: timelineDays,
      series: lineSeries,
      showSymbols: smoothing === 1 && timelineDays.length < 60,
      smoothed: smoothing > 1,
    })
  })

  function toggle(key) {
    steered.add('chosen')
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

<Frame column={COLUMN}>
<section>
  <header class="mb-6">
    <p class="meta">{allDays.length} {allDays.length === 1 ? 'day' : 'days'} recorded</p>
    <h1 class="mt-1 text-3xl font-bold tracking-tight">Patterns</h1>
  </header>

  {#if loading}
    <p class="meta">Loading…</p>
  <!-- Streaks needs no plottable variable and no answer at all: a habit defined
       this morning has a run of zero and a grid of empty cells, which is a
       reading rather than nothing. Only a catalogue with no habits *and*
       nothing to plot is genuinely empty. -->
  {:else if numeric.length === 0 && totalsVariables.length === 0 && habits.length === 0}
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
          aria-pressed={activeView === key}
          onclick={() => {
            steered.add('view')
            view = key
          }}
        >
          {label}
        </button>
      {/each}
    </div>

    <!-- Neither control belongs to the streak view. Its span is in periods
         rather than days, and it deliberately ignores the day filters: a streak
         over "only Saturdays" is not a streak, because the target says *per
         week* and narrowing the days silently changes what that means. -->
    {#if activeView === 'streaks'}
      <!-- Two groups, each of which holds together and wraps as a unit. Laid
           out by hand rather than left to one `flex-wrap`: a single wrapping
           row broke wherever it ran out of room, which on a phone put one span
           button on its own line, split "Up to today" across two, and dropped
           the arrow of "Next →" under its own word. A caption that can move to
           its own line while the buttons it labels stay side by side is the
           whole of the fix. -->
      <div class="mb-4 flex flex-col gap-3 rounded-xl border border-white/10
                  bg-ink-soft px-4 py-3 sm:flex-row sm:flex-wrap
                  sm:items-center sm:justify-between">
        <span class="flex flex-wrap items-center gap-2 sm:gap-3">
          <span class="meta shrink-0">Span</span>
          <!-- `flex-1` up to the breakpoint, so the pair fills the row it is on
               and comes out one width rather than two. Equal padding does not
               make equal buttons: "12 periods" and "26 periods" happen to be
               the same length, and the next span added would not be. -->
          <span class="flex flex-1 items-stretch gap-2 sm:flex-none sm:gap-3">
            {#each SPANS as span (span)}
              <button
                class="meta flex-1 rounded-md border px-3 py-2 whitespace-nowrap transition
                       sm:flex-none
                       {streakSpan === span
                  ? 'border-ember bg-ember/10 text-paper'
                  : 'border-white/15 hover:border-white/40'}"
                aria-pressed={streakSpan === span}
                data-span={span}
                onclick={() => {
                  steered.add('streakSpan')
                  streakSpan = span
                  // Back to the present on a change of span: a window measured
                  // in periods means a different stretch of calendar at each
                  // size, so "three windows back" would silently move as well
                  // as resize.
                  streakBack = 0
                }}
              >
                {span} periods
              </button>
            {/each}
          </span>
        </span>

        <!-- Stepped in whole windows, the way the time patterns page steps its
             own. Next stops at the present rather than wrapping, because there
             is nothing after today to look at. -->
        <span class="flex flex-wrap items-center gap-2 sm:gap-3">
          <span class="meta shrink-0 whitespace-nowrap" data-streak-back={streakBack}>
            {streakBack === 0
              ? 'Up to today'
              : `${streakBack} ${streakBack === 1 ? 'window' : 'windows'} back`}
          </span>
          <span class="flex flex-1 items-stretch gap-2 sm:flex-none sm:gap-3">
            <button
              class="meta flex-1 rounded-md border border-white/15 px-3 py-2
                     whitespace-nowrap hover:border-white/40 sm:flex-none"
              data-streak-step="back"
              onclick={() => (streakBack += 1)}
            >
              ← Previous
            </button>
            <button
              class="meta flex-1 rounded-md border border-white/15 px-3 py-2
                     whitespace-nowrap hover:border-white/40 disabled:opacity-30
                     disabled:hover:border-white/15 sm:flex-none"
              data-streak-step="forward"
              disabled={streakBack === 0}
              onclick={() => (streakBack = Math.max(0, streakBack - 1))}
            >
              Next →
            </button>
          </span>
        </span>
      </div>
    {:else}
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
          {#if activeView !== 'totals' && activeView !== 'streaks'}
            <div class="mb-3 flex items-center justify-between gap-3">
              <p class="meta">Variables</p>
              <span class="flex gap-3">
                <button
                  class="meta underline underline-offset-4 hover:text-paper"
                  onclick={() => {
                    steered.add('chosen')
                    chosen = new Set(numeric.map((v) => v.key))
                  }}
                >
                  All
                </button>
                <button
                  class="meta underline underline-offset-4 hover:text-paper"
                  onclick={() => {
                    steered.add('chosen')
                    chosen = new Set()
                  }}
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

          {#if filterable.length > 0 && activeView !== 'streaks'}
            <hr class="my-4 border-white/10" />
            <div class="mb-3 flex items-center justify-between gap-3">
              <p class="meta">Only days where</p>
              {#if activeFilters.length > 0}
                <button
                  class="meta underline underline-offset-4 hover:text-paper"
                  onclick={() => {
                    steered.add('filters')
                    filters = {}
                  }}
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
            oninput={(event) => {
              steered.add('windowDays')
              windowDays = Number(event.currentTarget.value)
            }}
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
              oninput={() => steered.add('smoothing')}
              class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep accent-ember"
            />
          </label>
        {/if}
      </div>
    </div>
    {/if}

    {#if activeView === 'streaks'}
      <StreakGrid
        habits={streakHabits}
        answers={rows}
        expected={expectedPerDay}
        span={streakSpan}
        offset={streakBack * streakSpan}
        from={today()}
      />
    {:else if activeView === 'scatter'}
      {#if ranked.length === 0}
        <div class="flex h-[26rem] items-center justify-center rounded-xl border
                    border-white/10 bg-ink-soft px-6 text-center">
          <p class="text-haze">
            Two scaled questions with answers on the same days are needed to
            compare any.
          </p>
        </div>
      {:else}
        <p class="meta mb-2 normal-case text-haze">
          Every pair, strongest first. {activeFilters.length
            ? 'Computed over the days the filters keep.'
            : 'Tap a pair to see it plotted.'}
        </p>
        <!-- Scrolls itself rather than the page: the point of the list is
             comparing the top of it against what follows, and a page-length
             list puts the strongest pair off screen the moment one is opened. -->
        <ul
          class="max-h-[32rem] overflow-y-auto rounded-xl border border-white/10 bg-ink-soft"
          data-correlations
        >
          {#each ranked as pair (keyOf(pair.x, pair.y))}
            {@const id = keyOf(pair.x, pair.y)}
            <li class="border-b border-white/5 last:border-b-0">
              <button
                class="flex w-full items-baseline justify-between gap-3 px-4 py-3
                       text-left transition hover:bg-dusk/10
                       {pair.ranked ? '' : 'opacity-45'}"
                aria-expanded={openPair === id}
                data-pair={id}
                onclick={() => (openPair = openPair === id ? null : id)}
              >
                <span class="min-w-0 truncate text-sm">
                  {pair.x.label} <span class="text-haze">↔</span> {pair.y.label}
                </span>
                <span class="flex shrink-0 items-baseline gap-3">
                  <!-- The number alone, with no "strong" or "weak" beside it:
                       where those thresholds sit is a matter of taste, and the
                       word would read as the app's opinion rather than as data. -->
                  <span class="numeral tabular-nums" data-rho>
                    {pair.rho === null ? '—' : pair.rho.toFixed(2)}
                  </span>
                  <span class="meta shrink-0" data-overlap>
                    {pair.reason === 'constant'
                      ? 'no variation'
                      : `${pair.overlap} ${pair.overlap === 1 ? 'day' : 'days'}`}
                  </span>
                </span>
              </button>
              {#if openPair === id && openPairPlot}
                <!-- Its own instance rather than the shared canvas above: only
                     one row is ever open, and `chartAction` already owns the
                     init, the resize listener and the dispose. -->
                <div use:chartAction={openPairPlot.options} class="h-80 w-full" data-scatter></div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if ranked.some((pair) => !pair.ranked)}
          <p class="meta mt-2 normal-case text-haze">
            Dimmed: fewer than {MINIMUM_OVERLAP} shared days, or no variation.
          </p>
        {/if}
      {/if}
    {:else if activeView === 'totals'}
      {#if totalsPlots.length === 0}
        <div class="flex h-[26rem] items-center justify-center rounded-xl border border-white/10
                    bg-ink-soft px-6 text-center">
          <p class="text-haze">No discrete or enum questions to total yet.</p>
        </div>
      {:else}
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          {#each totalsPlots as plot (plot.variable.key)}
            <!-- min-w-0: a grid item defaults to min-width: auto, so a card
                 holding a chart would otherwise refuse to shrink below the
                 canvas ECharts drew before the grid narrowed it, blowing the
                 track — and the page — out past the viewport. -->
            <div class="min-w-0 rounded-xl border border-white/10 bg-ink-soft p-4">
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
    {:else if plotted.length === 0}
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
                style:color="var(--color-chart-{(index % 6) + 1})"
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
</Frame>
