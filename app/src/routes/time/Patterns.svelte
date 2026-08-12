<script>
  import * as echarts from 'echarts'

  import { attempt } from '../../lib/api.js'
  import { timeSummary } from '../../lib/generated/sdk.gen'
  import { dayLabel, shiftDay, today } from '../../lib/day.js'
  import { formatDuration, hours, nowUtc } from '../../lib/time/duration.js'
  import DayTimeline from '../../lib/time/DayTimeline.svelte'
  import { barOptions, shareOptions, weekdayOptions } from '../../lib/time/time-charts.js'
  import {
    ensureProjects,
    ensureTags,
    projects as projectStore,
    tags as tagStore,
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
  const WINDOWS = [
    ['1', 'Day'],
    ['7', 'Week'],
    ['30', 'Month'],
    ['90', 'Quarter'],
  ]
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  let by = $state('project')
  let windowDays = $state(30)
  const dayView = $derived(windowDays === 1)
  let rows = $state([])
  let loading = $state(true)

  const end = today()
  const start = $derived(shiftDay(end, -(windowDays - 1)))

  const days = $derived(
    Array.from({ length: windowDays }, (_, index) => shiftDay(start, index))
  )

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

  const groups = $derived.by(() => {
    const seen = new Map()
    for (const row of rows) {
      if (!seen.has(row.key)) seen.set(row.key, new Map())
      seen.get(row.key).set(row.day, row.seconds)
    }
    return [...seen.entries()]
      .map(([key, byDay]) => ({
        key,
        ...describe(key),
        byDay,
        total: [...byDay.values()].reduce((sum, seconds) => sum + seconds, 0),
      }))
      .sort((a, b) => b.total - a.total)
  })

  const tracked = $derived(groups.reduce((sum, group) => sum + group.total, 0))

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

  const barInput = $derived({
    days,
    series: groups.map((group) => ({
      name: group.name,
      colour: swatch(group.colour),
      data: days.map((day) => hours(group.byDay.get(day) ?? 0)),
    })),
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

  $effect(() => {
    if (!dayView) load(by, start, end)
  })

  async function load(grouping, from, to) {
    loading = true
    try {
      await Promise.all([ensureProjects(), ensureTags()])
      rows =
        (await attempt(() =>
          timeSummary({ query: { start: from, end: to, by: grouping, as_of: nowUtc() } })
        )) ?? []
    } finally {
      loading = false
    }
  }

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
  <p class="meta">
    {dayView ? 'When the hours went' : `${formatDuration(tracked)} tracked since ${dayLabel(start)}`}
  </p>
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

    <div class="ml-auto flex gap-1" role="group" aria-label="Window">
      {#each WINDOWS as [value, label] (value)}
        <button
          class="meta rounded-md border px-4 py-2 transition
                 {windowDays === Number(value)
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={windowDays === Number(value)}
          onclick={() => (windowDays = Number(value))}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  {#if dayView}
    <DayTimeline {by} />
  {:else if loading}
    <p class="meta">Loading…</p>
  {:else if groups.length === 0}
    <p class="rounded-xl border border-white/10 bg-ink-soft px-5 py-8 text-haze">
      Nothing tracked in this window yet.
    </p>
  {:else}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
      <div use:chart={barOptions(barInput)} class="h-80 w-full"></div>
      <!-- Both captions state an overlap rather than smoothing it over. Two
           timers at once genuinely put more tracked hours in a day than it has;
           a project under two tags genuinely counts in both. -->
      {#if overlapping}
        <p class="meta mt-2 normal-case">
          Days past 24 hours ran timers in parallel; each is counted.
        </p>
      {/if}
      {#if by === 'tag'}
        <p class="meta mt-2 normal-case">
          A project with several tags counts under each, so these totals overlap.
        </p>
      {/if}
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
        <p class="meta mb-2">Share of tracked time</p>
        <div use:chart={shareOptions(shareInput)} class="h-72 w-full"></div>
      </div>
      <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
        <p class="meta mb-2">Average by weekday</p>
        <div use:chart={weekdayOptions(weekdayInput)} class="h-72 w-full"></div>
      </div>
    </div>

    <table class="mt-6 w-full">
      <thead>
        <tr class="border-b border-white/10 text-left">
          <th class="meta py-2">{by === 'tag' ? 'Tag' : 'Project'}</th>
          <th class="meta py-2 text-right">Tracked</th>
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
              {formatDuration(group.total)}
            </td>
            <td class="numeral py-2 text-right tabular-nums text-haze">
              {tracked ? Math.round((group.total / tracked) * 100) : 0}%
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>
