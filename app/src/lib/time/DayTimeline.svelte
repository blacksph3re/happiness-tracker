<script>
  import { dayLabel, shiftDay, today } from '../day.js'
  import { clockOfSeconds, formatDuration, slices } from './duration.js'
  import { now } from './tick.js'
  import {
    ensureProjects,
    ensureTags,
    ensureTimeEntries,
    projects as projectStore,
    tags as tagStore,
    timeEntries,
  } from '../store.js'

  /**
   * One day as a horizontal timeline: when each project was actually running.
   *
   * The other windows answer "how much"; this one answers "when", which a bar
   * chart cannot. It is also the only place overlap is visible *as* overlap — a
   * meeting sitting inside a work session shows as two lanes covering the same
   * stretch of afternoon, rather than as two numbers that happen to add past the
   * length of a day.
   */
  let { by = 'project' } = $props()

  const DAY_SECONDS = 86_400
  const HOUR = 3600

  /** Days either side of the one shown that are fetched with it, so stepping is free. */
  const NEIGHBOURS = 3

  let day = $state(today())
  let loading = $state(true)
  let fullDay = $state(false)

  const projects = $derived(new Map(($projectStore ?? []).map((p) => [p.id, p])))

  /**
   * Every span falling on this day, in one lane per group.
   *
   * A span always keeps its own project's colour, whichever grouping is in
   * force: the lane says which tag, the colour still says which project, so
   * grouping by tag loses no information here the way a summed bar would.
   */
  const lanes = $derived.by(() => {
    const byGroup = new Map()
    for (const entry of $timeEntries) {
      const project = projects.get(entry.project_id)
      if (!project) continue
      const keys =
        by === 'tag'
          ? project.tags.length
            ? project.tags.map((tag) => tag.id)
            : [null]
          : [project.id]

      for (const slice of slices(entry, $now)) {
        if (slice.day !== day || slice.to <= slice.from) continue
        for (const key of keys) {
          if (!byGroup.has(key)) byGroup.set(key, [])
          byGroup.get(key).push({ ...slice, entry, project })
        }
      }
    }

    const named = new Map(($tagStore ?? []).map((tag) => [tag.id, tag]))
    return [...byGroup.entries()]
      .map(([key, spans]) => ({
        key,
        label:
          by === 'tag'
            ? (named.get(key)?.name ?? 'Untagged')
            : (projects.get(key)?.name ?? ''),
        colour:
          by === 'tag'
            ? (named.get(key)?.colour ?? 'haze')
            : (projects.get(key)?.colour ?? 'haze'),
        spans: spans.toSorted((a, b) => a.from - b.from),
        total: spans.reduce((sum, span) => sum + span.seconds, 0),
      }))
      .sort((a, b) => a.spans[0].from - b.spans[0].from)
  })

  const tracked = $derived(lanes.reduce((sum, lane) => sum + lane.total, 0))

  /**
   * The stretch of the day the axis covers.
   *
   * A full 24 hours spends most of its width on an empty night, so the default
   * is the hours actually used, rounded out to whole ones. `fullDay` puts the
   * whole thing back when the shape of the day matters more than its detail.
   */
  const window = $derived.by(() => {
    if (fullDay || lanes.length === 0) return { from: 0, to: DAY_SECONDS }
    const spans = lanes.flatMap((lane) => lane.spans)
    const first = Math.min(...spans.map((span) => span.from))
    const last = Math.max(...spans.map((span) => span.to))
    return {
      from: Math.max(0, Math.floor(first / HOUR) * HOUR - HOUR),
      to: Math.min(DAY_SECONDS, Math.ceil(last / HOUR) * HOUR + HOUR),
    }
  })

  const span = $derived(Math.max(HOUR, window.to - window.from))

  /** How wide the lanes are, so the axis can be thinned to fit them. */
  let laneWidth = $state(600)

  /** Pixels an hour label needs to itself before the next one crowds it. */
  const MIN_TICK_GAP = 56

  /** Hour marks across the axis, thinned to whatever the screen can hold. */
  const ticks = $derived.by(() => {
    const hours = span / HOUR
    // Spacing by hours alone is what made a phone draw six labels into 180px.
    const perHour = laneWidth / hours
    const step = [1, 2, 3, 4, 6, 12].find((n) => n * perHour >= MIN_TICK_GAP) ?? 12
    const marks = []
    for (let at = Math.ceil(window.from / HOUR) * HOUR; at <= window.to; at += HOUR) {
      if ((at / HOUR) % step === 0) marks.push(at)
    }
    return marks
  })

  /** Where a moment sits across the axis, as a percentage. */
  function position(seconds) {
    return ((seconds - window.from) / span) * 100
  }

  const isToday = $derived(day === today())

  /** Seconds since local midnight, for the "now" marker. */
  const nowSeconds = $derived.by(() => {
    const at = new Date($now)
    return at.getHours() * HOUR + at.getMinutes() * 60 + at.getSeconds()
  })

  $effect(() => {
    load(day)
  })

  async function load(shown) {
    try {
      await Promise.all([
        ensureProjects(),
        ensureTags(),
        ensureTimeEntries({
          start: shiftDay(shown, -NEIGHBOURS),
          end: shiftDay(shown, NEIGHBOURS),
        }),
      ])
    } finally {
      loading = false
    }
  }
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
  <p class="meta">
    {dayLabel(day)} · {formatDuration(tracked)} tracked
  </p>
  <div class="flex flex-wrap gap-2">
    <button
      class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
      onclick={() => (day = shiftDay(day, -1))}
    >
      ← Previous
    </button>
    <button
      class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
             disabled:cursor-not-allowed disabled:opacity-30"
      disabled={isToday}
      onclick={() => (day = shiftDay(day, 1))}
    >
      Next →
    </button>
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
  </div>
</div>

{#if loading}
  <p class="meta">Loading…</p>
{:else if lanes.length === 0}
  <p class="rounded-xl border border-white/10 bg-ink-soft px-5 py-8 text-haze">
    Nothing tracked on this day.
  </p>
{:else}
  <div class="rounded-xl border border-white/10 bg-ink-soft p-4" data-timeline={day}>
    <!-- The axis and every lane share one grid, so a bar and its hour line up
         whatever the label column ends up measuring. -->
    <div class="grid grid-cols-[5rem_1fr] items-center gap-y-1 sm:grid-cols-[10rem_1fr]">
      <span></span>
      <div class="relative h-5" bind:clientWidth={laneWidth}>
        {#each ticks as tick (tick)}
          <span
            class="meta absolute -translate-x-1/2 whitespace-nowrap"
            style:left="{position(tick)}%"
          >
            {clockOfSeconds(tick)}
          </span>
        {/each}
      </div>

      {#each lanes as lane (lane.key ?? 'untagged')}
        <span class="min-w-0 pr-3">
          <span class="flex items-center gap-2">
            <span
              class="size-2.5 shrink-0 rounded-full"
              style:background="var(--color-{lane.colour}, var(--color-dusk-lift))"
            ></span>
            <span class="truncate text-sm font-medium">{lane.label}</span>
          </span>
          <span class="meta numeral ml-4.5 block">{formatDuration(lane.total)}</span>
        </span>

        <div class="relative h-10 rounded-md border border-white/5 bg-ink" data-lane={lane.key}>
          {#each ticks as tick (tick)}
            <span
              class="absolute inset-y-0 w-px bg-white/5"
              style:left="{position(tick)}%"
            ></span>
          {/each}

          {#each lane.spans as span_ (span_.entry.id + span_.from)}
            <!-- A quarter-hour session is a sliver at day scale, so every bar
                 keeps a floor width: a session that happened must be visible. -->
            <span
              class="absolute inset-y-1 rounded-sm"
              style:left="{position(span_.from)}%"
              style:width="{Math.max(0, position(span_.to) - position(span_.from))}%"
              style:min-width="3px"
              style:background="var(--color-{span_.project
                .colour}, var(--color-dusk-lift))"
              style:opacity={span_.entry.ended_at ? 0.85 : 1}
              title="{span_.project.name} · {clockOfSeconds(span_.from)}–{span_.entry.ended_at
                ? clockOfSeconds(span_.to)
                : 'running'} · {formatDuration(span_.seconds)}"
            ></span>
          {/each}

          {#if isToday && nowSeconds >= window.from && nowSeconds <= window.to}
            <span
              class="absolute inset-y-0 -ml-px w-0.5 bg-ember"
              style:left="{position(nowSeconds)}%"
            ></span>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <p class="meta mt-3 normal-case">
    {#if !fullDay}
      {clockOfSeconds(window.from)}–{clockOfSeconds(window.to === DAY_SECONDS ? 0 : window.to)}.
    {/if}
    {#if lanes.length > 1}
      Overlapping lanes ran at once.
    {/if}
  </p>
{/if}
