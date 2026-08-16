<script>
  import * as echarts from 'echarts'

  import { answerFacet, matchingDays, weekdayFacet } from '../../lib/facets.js'
  import { resource } from '../../lib/resource.svelte.js'
  import { ensureSummary } from '../../lib/store.js'
  import { dayLabel, shiftDay, today } from '../../lib/day.js'
  import { daysIn, period, stepPeriod } from '../../lib/time/period.js'
  import { formatDuration, hours, nowUtc } from '../../lib/time/duration.js'
  import DayTimeline from '../../lib/time/DayTimeline.svelte'
  import { movingAverage } from '../../lib/series.js'
  import {
    barOptions,
    lineOptions,
    shareOptions,
    weekdayOptions,
  } from '../../lib/time/time-charts.js'
  import {
    answers as answerStore,
    ensureAnswers,
    ensureDeductionRules,
    ensureProjects,
    ensureTags,
    ensureTimeEntries,
    ensureTrackedRange,
    ensureVariables,
    projects as projectStore,
    tags as tagStore,
    trackedDays,
    variables as variableStore,
  } from '../../lib/store.js'

  /**
   * Where the hours went, by project or by tag.
   *
   * The totals come from the server, already split at midnight and already
   * grouped — the one place that arithmetic happens, so this page and the
   * spreadsheet cannot disagree about a day.
   */

  // Day is a window like the others, but the shortest one is the only one worth
  // drawing along a clock rather than as totals - so choosing it swaps the
  // charts for the timeline instead of narrowing them to a single column.
  // Named periods rather than rolling day counts: "the previous 30 days" has
  // no previous and no name, so neither could be put on the page.
  const WINDOWS = [
    ['day', 'Day'],
    ['week', 'Week'],
    ['month', 'Month'],
    ['quarter', 'Quarter'],
    ['custom', 'Custom'],
  ]

  const MAX_CUSTOM_DAYS = 365
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  /** The widest smoothing the slider offers, and the reach it needs either side. */
  const MAX_SMOOTHING = 14

  const MAX_PAD = Math.floor((MAX_SMOOTHING - 1) / 2)

  let by = $state('project')
  let unit = $state('month')
  let anchor = $state(today())
  let customDays = $state(30)
  const dayView = $derived(unit === 'day')

  const shown = $derived(period(unit, anchor, customDays))
  // The current period runs to today, not to its calendar end: half a month of
  // flat zeroes to the right is a chart of days that have not happened.
  const days = $derived(
    daysIn(unit, anchor, customDays).filter((day) => day <= today())
  )
  const start = $derived(shown.start)
  const end = $derived(shown.end)

  /** Whether the period shown already contains today. */
  const atLatest = $derived(today() >= start && today() <= end)

  /** How many days back the custom window ends, for the slider's position. */
  const endsOffset = $derived(
    Math.round((Date.parse(anchor) - Date.parse(today())) / 86_400_000)
  )

  /**
   * How far back the sliders may reach: the first day anything was tracked.
   *
   * Sliding into years that hold nothing is a control that mostly does nothing,
   * so the range stops where the history does. A day of slack keeps the first
   * day itself reachable.
   */
  const earliest = $derived(
    Math.min(
      -1,
      $trackedDays?.first
        ? Math.round((Date.parse($trackedDays.first) - Date.parse(today())) / 86_400_000)
        : -MAX_CUSTOM_DAYS
    )
  )

  const maxLength = $derived(Math.max(1, Math.min(MAX_CUSTOM_DAYS, -earliest + 1)))


  /** Name and colour for a summary key, whichever grouping is in force. */
  const describe = $derived.by(() => {
    const source = by === 'tag' ? ($tagStore ?? []) : ($projectStore ?? [])
    const known = new Map(source.map((item) => [item.id, item]))
    return (key) => {
      if (key === null) return { name: 'Untagged', colour: 'haze' }
      const item = known.get(key)
      return item
        ? { name: item.name, colour: item.colour }
        : { name: 'Removed', colour: 'haze' }
    }
  })

  /**
   * Each group's day-by-day seconds, *after* its rule.
   *
   * Reported rather than tracked, everywhere and without a second column
   * beside it: a tag carrying a lunch rule is a tag whose hours are the hours
   * it reports, and showing the un-deducted figure next to it only invites the
   * question of which one counts. A tag whose raw hours matter is a tag with no
   * rule on it — or a second tag over the same projects.
   *
   * Wherever no rule applies, which is every project and most tags, `reported`
   * equals what was tracked and nothing here changes.
   */
  const groups = $derived.by(() => {
    const shown = new Map()
    const raw = new Map()
    for (const row of rows) {
      if (!shown.has(row.key)) {
        shown.set(row.key, new Map())
        raw.set(row.key, new Map())
      }
      shown.get(row.key).set(row.day, row.reported ?? row.seconds)
      raw.get(row.key).set(row.day, row.seconds)
    }
    const summed = (byDay) =>
      [...byDay.entries()]
        .filter(([day]) => kept.has(day))
        .reduce((sum, [, seconds]) => sum + seconds, 0)

    return (
      [...shown.entries()]
        .map(([key, byDay]) => ({
          key,
          ...describe(key),
          byDay,
          total: summed(byDay),
          // Kept for the table alone, which is the one place both numbers
          // belong: reading them side by side is what says how much the rule
          // took. Every other view — the charts, the shares, the caption —
          // reads `total`, which is what the tag reports.
          trackedTotal: summed(raw.get(key)),
        }))
        // A tag every day of which the filters left out is a legend entry, a
        // slice of nothing and a table row reading zero. It is not in the window
        // being looked at, so it is not on the page.
        .filter((group) => group.trackedTotal > 0)
        .sort((a, b) => b.total - a.total)
    )
  })

  const tracked = $derived(groups.reduce((sum, group) => sum + group.total, 0))

  /**
   * Whether a rule actually took something off what is shown.
   *
   * Only ever used to *say so*. The numbers are the reported ones either way;
   * this decides whether the page calls them reported or tracked, so a figure
   * that has had an hour removed never reads as the hours worked.
   */
  const deducted = $derived(rows.some((row) => (row.deduction ?? 0) > 0))

  const overlapping = $derived(
    days.some(
      (day) =>
        groups.reduce((sum, group) => sum + (group.byDay.get(day) ?? 0), 0) > 86_400
    )
  )

  /**
   * Resolve a palette token to the value ECharts needs.
   *
   * Read from inside the section, not from the document root: the time half
   * rebinds the accent variables, so a project coloured `dusk-lift` is teal
   * here and purple there. Reading the root would make the chart disagree with
   * the very swatch beside it.
   */
  function swatch(token) {
    if (typeof document === 'undefined') return undefined
    const scope = document.querySelector('.section-time') ?? document.documentElement
    return getComputedStyle(scope).getPropertyValue(`--color-${token}`).trim() || undefined
  }

  const plotted = $derived(days.filter((day) => kept.has(day)))

  /** Half a smoothing window: how far past each edge an average has to reach. */
  const smoothingPad = $derived(smoothing > 1 ? Math.floor((smoothing - 1) / 2) : 0)

  /**
   * The days an average is computed over: the window, plus half a window
   * either side of it.
   *
   * Without the padding the average at each edge was taken over however much of
   * its window happened to fall inside the period, so the first and last days
   * of every month read as a taper that is an artefact of where the month was
   * cut rather than anything that was worked. The padding is averaged over and
   * then cut off again, so what is drawn is still exactly the window.
   *
   * Padding days are filtered like any other — "only days I worked from home"
   * must not be quietly broken by the six days before the first of the month —
   * and nothing after today is reached for, there being nothing there yet.
   */
  const padded = $derived.by(() => {
    if (smoothingPad === 0 || plotted.length === 0) {
      return { days: plotted, lead: 0, tail: 0 }
    }
    const before = []
    const after = []
    for (let step = smoothingPad; step >= 1; step -= 1) {
      before.push(shiftDay(plotted[0], -step))
    }
    for (let step = 1; step <= smoothingPad; step += 1) {
      const day = shiftDay(plotted.at(-1), step)
      if (day <= today()) after.push(day)
    }
    const allowed = matchingDays([...before, ...after], facets, filters)
    const lead = before.filter((day) => allowed.has(day))
    const tail = after.filter((day) => allowed.has(day))
    return { days: [...lead, ...plotted, ...tail], lead: lead.length, tail: tail.length }
  })

  const seriesInput = $derived({
    days: plotted,
    smoothed: smoothing > 1,
    series: groups.map((group) => {
      const value = (day) =>
        group.byDay.has(day) ? hours(group.byDay.get(day)) : showGaps ? null : 0
      if (smoothing <= 1) {
        return { name: group.name, colour: swatch(group.colour), data: plotted.map(value) }
      }
      // Smoothing reads through a gap, which is the point of the control: a
      // wider window closes the holes a sparse week leaves.
      const averaged = movingAverage(
        padded.days.map((day) => value(day) ?? 0),
        smoothing
      )
      return {
        name: group.name,
        colour: swatch(group.colour),
        // Back to the window: the padding was there to be averaged over, not
        // to be drawn, and drawing it would widen the period behind the reader.
        data: averaged.slice(padded.lead, averaged.length - padded.tail),
      }
    }),
  })

  const shareInput = $derived({
    slices: groups.map((group) => ({
      name: group.name,
      value: hours(group.total),
      colour: swatch(group.colour),
    })),
  })

  const weekdayInput = $derived({
    labels: WEEKDAYS,
    series: groups.map((group) => ({
      name: group.name,
      colour: swatch(group.colour),
      data: WEEKDAYS.map((_, index) => {
        const matching = days.filter((day) => weekdayIndex(day) === index)
        const total = matching.reduce(
          (sum, day) => sum + (group.byDay.get(day) ?? 0),
          0
        )
        return matching.length ? hours(total / matching.length) : 0
      }),
    })),
  })

  function weekdayIndex(day) {
    const [year, month, date] = day.split('-').map(Number)
    return (new Date(year, month - 1, date).getDay() + 6) % 7
  }

  let fullDay = $state(false)
  let smoothing = $state(1)
  let showGaps = $state(false)
  let filters = $state({})
  let filtersOpen = $state(false)

  /**
   * What a day can be filtered on.
   *
   * Weekday comes from the calendar; everything else comes from the
   * questionnaire, so "only days where I worked from home" narrows the hours
   * even though the two halves record separately.
   */
  const facets = $derived.by(() => {
    const all = daysIn(unit, anchor, customDays)
    const fromAnswers = ($variableStore ?? [])
      .filter((variable) => variable.roles.includes('filter') || variable.kind === 'enum')
      .filter((variable) => variable.system_key !== 'weekday')
      .map((variable) => answerFacet(variable, $answerStore))
      .filter(Boolean)
    return [weekdayFacet(all), ...fromAnswers]
  })

  const activeFilters = $derived(
    facets.filter((facet) => filters[facet.key]?.size).length
  )

  const kept = $derived(matchingDays(days, facets, filters))

  function toggleFacet(key, id) {
    const held = new Set(filters[key] ?? [])
    if (held.has(id)) held.delete(id)
    else held.add(id)
    filters = { ...filters, [key]: held }
  }

  // A week of bars is readable; a quarter of them is a picket fence. The long
  // windows get a line, and with it something to smooth.
  const asLine = $derived(unit === 'month' || unit === 'quarter' || days.length > 14)

  /**
   * Whether the window is short enough to draw along a clock.
   *
   * A day and a week both fit: one lane per project, or one per day. A month of
   * lanes would be thirty rows of slivers, so the long windows answer "how
   * much" and leave "when" to the shorter ones.
   *
   * Always by project, whichever grouping the rest of the page is using. A lane
   * says when something ran, and a tag does not run — its projects do. Taking
   * the strip away entirely in tag mode was the wrong conclusion from that: the
   * short windows *are* the strip, and without it "Day" is a donut of one day.
   */
  const strip = $derived(!asLine)

  // The page reads its totals; it does not own them. A component that cannot
  // assign to `rows` or `loading` cannot feed them back into the query, which
  // is the shape of the loop that once froze this view.
  const summary = resource(
    // Fetched a fixed six days wider than the window at both ends, so a
    // smoothed line has real neighbours to average with at its edges instead of
    // tapering into a half-window. Fixed rather than `smoothingPad`, or every
    // notch of the slider would be a different range and a fresh request.
    () => ({ by, start: shiftDay(start, -MAX_PAD), end: shiftDay(end, MAX_PAD), dayView }),
    async ({ by: grouping, start: from, end: to }) => {
      await Promise.all([
        ensureProjects(),
        ensureTags(),
        // The sessions themselves, which this page never draws directly — it
        // reads totals. They are fetched so that the totals can still be worked
        // out here when there is nothing to ask: a page that only ever held
        // somebody else's arithmetic has nothing to fall back on.
        ensureTimeEntries({ start: from, end: to }),
        ensureDeductionRules(),
        // The questionnaire's answers become filters here, so the two halves
        // can be read against each other.
        ensureVariables(),
        ensureAnswers(),
        ensureTrackedRange(),
      ])
      return ensureSummary({ start: from, end: to, by: grouping, as_of: nowUtc() })
    },
    { name: 'time summary', initial: [] }
  )

  const rows = $derived(summary.data ?? [])
  const loading = $derived(summary.loading && rows.length === 0)

  /** Mount an ECharts instance and keep it fed, disposing it on teardown. */
  function chart(node, options) {
    const instance = echarts.init(node, null, { renderer: 'canvas' })
    instance.setOption(options)
    const resize = () => instance.resize()
    window.addEventListener('resize', resize)
    return {
      update(next) {
        instance.setOption(next, { notMerge: true })
      },
      destroy() {
        window.removeEventListener('resize', resize)
        instance.dispose()
      },
    }
  }
</script>

<section class="mx-auto w-full max-w-5xl px-5 py-8">
  <p class="meta">{dayView ? 'When the hours went' : 'Where the hours went'}</p>
  <h1 class="mt-1 mb-6 text-3xl font-bold tracking-tight">Patterns</h1>

  <div class="mb-6 flex flex-wrap items-center gap-2">
    <div class="flex gap-1" role="group" aria-label="Group by">
      {#each [['project', 'By project'], ['tag', 'By tag']] as [value, label] (value)}
        <button
          class="meta rounded-md border px-4 py-2 transition
                 {by === value
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={by === value}
          onclick={() => (by = value)}
        >
          {label}
        </button>
      {/each}
    </div>

    <!-- Wraps, or five buttons at 79px each hang three pixels past a 390px
         phone and give the whole page a horizontal scroll. -->
    <div class="ml-auto flex flex-wrap gap-1" role="group" aria-label="Window">
      {#each WINDOWS as [value, label] (value)}
        <button
          class="meta rounded-md border px-4 py-2 transition
                 {unit === value
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={unit === value}
          onclick={() => (unit = value)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  {#if unit === 'custom'}
    <!-- Length and where it ends, the pair the questions page steers by, so
         both halves of the app frame a window the same way. -->
    <div class="mb-4 flex flex-col gap-4 rounded-xl border border-white/10 bg-ink-soft p-4">
      <label class="flex flex-col gap-2">
        <span class="meta">Length · {customDays} {customDays === 1 ? 'day' : 'days'}</span>
        <input
          type="range"
          min="1"
          max={maxLength}
          bind:value={customDays}
          aria-label="Window length"
          class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep accent-ember"
        />
      </label>
      <label class="flex flex-col gap-2">
        <span class="meta">Ends on · {dayLabel(anchor, { withYear: true })}</span>
        <input
          type="range"
          min={earliest}
          max="0"
          value={endsOffset}
          aria-label="Ends on"
          oninput={(event) => (anchor = shiftDay(today(), Number(event.currentTarget.value)))}
          class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep accent-ember"
        />
      </label>
    </div>
  {/if}

  <!-- Which week, which month, which quarter — and a way to the one before.
       A window you cannot step through can only ever show the present. -->
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <p class="meta" data-period>
      {dayView ? dayLabel(anchor) : shown.label}
      <!-- "reported" wherever a rule took something off, because the number is
           then not the hours worked and must not read as though it were. -->
      · {formatDuration(tracked)}{deducted ? ' reported' : ''}{by === 'tag'
        ? ' across tags'
        : deducted
          ? ''
          : ' tracked'}
    </p>
    <div class="flex gap-2">
      <!-- Custom is steered by its own sliders; a Previous that slid the window
           by its length would be a second way to say the same thing. -->
      {#if unit !== 'custom'}
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
          onclick={() => (anchor = stepPeriod(unit, anchor, -1, customDays))}
        >
          ← Previous
        </button>
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                 disabled:cursor-not-allowed disabled:opacity-30"
          disabled={atLatest}
          onclick={() => (anchor = stepPeriod(unit, anchor, 1, customDays))}
        >
          Next →
        </button>
      {/if}
      {#if dayView}
        <button
          class="meta rounded-md border px-3 py-2 transition
                 {fullDay
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={fullDay}
          onclick={() => (fullDay = !fullDay)}
        >
          Full day
        </button>
      {/if}
    </div>
  </div>

  {#if !dayView}
    <div class="mb-4 rounded-xl border border-white/10 bg-ink-soft">
      <!-- A whole row that answers a click has to answer a pointer too; the
           card treatment, since that is what this is the header of. -->
      <button
        class="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3
               text-left hover:bg-dusk/10"
        aria-expanded={filtersOpen}
        onclick={() => (filtersOpen = !filtersOpen)}
      >
        <span class="meta">
          Only days where
          {#if activeFilters}· {plotted.length} of {days.length} days{/if}
        </span>
        <span class="meta">{filtersOpen ? 'Hide' : 'Change'}</span>
      </button>

      {#if filtersOpen}
        <div class="flex flex-col gap-4 border-t border-white/10 p-4">
          {#each facets as facet (facet.key)}
            <div class="flex flex-col gap-2">
              <p class="meta">{facet.label}</p>
              <div class="flex flex-wrap gap-2">
                {#each facet.choices as choice (choice.id)}
                  <button
                    class="meta rounded-md border px-3 py-2 transition
                           {filters[facet.key]?.has(choice.id)
                      ? 'border-ember bg-ember/10 text-paper'
                      : 'border-white/15 hover:border-white/40'}"
                    aria-pressed={filters[facet.key]?.has(choice.id) ?? false}
                    onclick={() => toggleFacet(facet.key, choice.id)}
                  >
                    {choice.label}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
          <p class="meta normal-case">
            {activeFilters
              ? 'Days without a reading for an active filter are left out.'
              : 'Nothing selected, so every day counts.'}
          </p>
        </div>
      {/if}
    </div>
  {/if}

  {#if strip}
    <div class="mb-4">
      <DayTimeline bind:day={anchor} bind:fullDay days={dayView ? null : days} />
    </div>
  {/if}

  {#if loading}
    <p class="meta">Loading…</p>
  {:else if groups.length === 0}
    <!-- Every card the window would have, empty. Sliding past the end of the
         history should not rearrange the page under the control being moved. -->
    {#if asLine}
      <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
        <div class="flex h-80 items-center justify-center text-haze">
          Nothing tracked in this window.
        </div>
      </div>
    {/if}
    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      {#each ['Share of tracked time', asLine ? 'Average by weekday' : 'Hours per day'] as title (title)}
        <div class="min-w-0 rounded-xl border border-white/10 bg-ink-soft p-4">
          <p class="meta mb-2">{title}</p>
          <div class="flex h-72 items-center justify-center text-haze">
            Nothing tracked in this window.
          </div>
        </div>
      {/each}
    </div>
    <!-- The group table's own header, so the page keeps its full height. -->
    <table class="mt-6 w-full">
      <thead>
        <tr class="border-b border-white/10 text-left">
          <th class="meta py-2">{by === 'tag' ? 'Tag' : 'Project'}</th>
          <th class="meta py-2 text-right">Tracked</th>
          <th class="meta py-2 text-right">Share</th>
        </tr>
      </thead>
    </table>
  {:else}
    {#if asLine}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
      <div use:chart={lineOptions(seriesInput)} class="h-80 w-full"></div>
      {#if asLine}
        <div class="mt-3 flex flex-wrap items-center gap-4">
          <label class="flex min-w-56 flex-1 items-center gap-3">
            <span class="meta shrink-0">
              Smoothing · {smoothing === 1 ? 'every day' : `${smoothing} days`}
            </span>
            <input
              type="range"
              min="1"
              max={MAX_SMOOTHING}
              bind:value={smoothing}
              aria-label="Smoothing"
              class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep
                     accent-ember"
            />
          </label>
          <!-- A day with nothing tracked is not a day of zero hours; whether it
               should read as one is a judgement, so it is offered rather than
               assumed. Smoothing reads across the gaps either way. -->
          <label class="flex shrink-0 items-center gap-2">
            <input type="checkbox" bind:checked={showGaps} class="accent-dusk" />
            <span class="meta">Untracked days break the line</span>
          </label>
        </div>
      {/if}
      <!-- Both captions state an overlap rather than smoothing it over. Two
           timers at once genuinely put more tracked hours in a day than it has;
           a project under two tags genuinely counts in both. -->
      {#if overlapping}
        <p class="meta mt-2 normal-case">
          Days past 24 hours ran timers in parallel; each is counted.
        </p>
      {/if}
    </div>
    {/if}

    {#if by === 'tag'}
      <p class="meta mt-4 normal-case">
        A project with several tags counts under each, so these totals overlap —
        they add to more than the hours actually tracked.
      </p>
    {/if}

    <!-- The same pair under every window: what the time was spent on, and how
         it was distributed. Only the second card changes with the length of the
         period — days when there are few, weekday averages when there are many. -->
    <!-- `min-w-0` on the items, and it is load-bearing: a grid track sizes to
         its content's minimum, an ECharts canvas carries an inline pixel width,
         and the two deadlock. Narrowing the window left the canvas at its old
         width, which held the card at that width, which left the canvas nothing
         smaller to resize to — so the card hung past the edge of the page. -->
    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <div class="min-w-0 rounded-xl border border-white/10 bg-ink-soft p-4">
        <p class="meta mb-2">Share of tracked time</p>
        <div use:chart={shareOptions(shareInput)} class="h-72 w-full"></div>
      </div>
      <div class="min-w-0 rounded-xl border border-white/10 bg-ink-soft p-4">
        <p class="meta mb-2">
          {asLine ? 'Average by weekday' : 'Hours per day'}
        </p>
        <div
          use:chart={asLine ? weekdayOptions(weekdayInput) : barOptions(seriesInput)}
          class="h-72 w-full"
        ></div>
      </div>
    </div>

    <table class="mt-6 w-full">
      <thead>
        <tr class="border-b border-white/10 text-left">
          <th class="meta py-2">{by === 'tag' ? 'Tag' : 'Project'}</th>
          <th class="meta py-2 text-right">Tracked</th>
          {#if deducted}<th class="meta py-2 text-right">Reported</th>{/if}
          <th class="meta py-2 text-right">Share</th>
        </tr>
      </thead>
      <tbody>
        {#each groups as group (group.key ?? 'untagged')}
          <tr class="border-b border-white/5" data-group={group.name}>
            <td class="flex items-center gap-2 py-2">
              <span
                class="size-2.5 rounded-full"
                style:background="var(--color-{group.colour}, var(--color-dusk-lift))"
              ></span>
              {group.name}
            </td>
            <td class="numeral py-2 text-right tabular-nums">
              {formatDuration(group.trackedTotal)}
            </td>
            {#if deducted}
              <td class="numeral py-2 text-right tabular-nums">
                {formatDuration(group.total)}
              </td>
            {/if}
            <td class="numeral py-2 text-right tabular-nums text-haze">
              {tracked ? Math.round((group.total / tracked) * 100) : 0}%
            </td>
          </tr>
        {/each}
      </tbody>
      <!-- The column had a per-group number and no answer to "and altogether?".
           Named "across tags" when grouping by tag, because there it is the sum
           of overlapping rows rather than the hours the window holds. -->
      <tfoot>
        <tr class="border-t border-white/15" data-total>
          <td class="py-2 font-medium">
            {by === 'tag' ? 'Total across tags' : 'Total'}
          </td>
          <td class="numeral py-2 text-right font-medium tabular-nums">
            {formatDuration(groups.reduce((sum, group) => sum + group.trackedTotal, 0))}
          </td>
          {#if deducted}
            <td class="numeral py-2 text-right font-medium tabular-nums">
              {formatDuration(tracked)}
            </td>
          {/if}
          <!-- 100, not the sum of the column above it: the shares are rounded
               per row and would read 99% or 101% often enough to look wrong. -->
          <td class="numeral py-2 text-right tabular-nums text-haze">100%</td>
        </tr>
      </tfoot>
    </table>
  {/if}
</section>
