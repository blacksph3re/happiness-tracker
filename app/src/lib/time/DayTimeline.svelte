<script>
  import { dayLabel, shiftDay, today } from '../day.js'
  import { clockOfSeconds, dayOffsets, formatDuration, slices } from './duration.js'
  import { now } from './tick.js'
  import { resource } from '../resource.svelte.js'
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
  let {
    by = 'project',
    day = $bindable(today()),
    fullDay = $bindable(false),
    days = null,
  } = $props()

  /**
   * Whether the strip shows a run of days rather than one.
   *
   * A week has too little to say per project per day to give each project its
   * own lane seven times over; a lane per *day*, with the blocks coloured by
   * project, is the same picture at the scale that fits.
   */
  const byDay = $derived(Array.isArray(days) && days.length > 1)
  const shown = $derived(byDay ? days : [day])

  const DAY_SECONDS = 86_400
  const HOUR = 3600

  /** Days either side of the one shown that are fetched with it, so stepping is free. */
  const NEIGHBOURS = 3


  const SWIPE_THRESHOLD = 48
  let touchStartX = 0

  function onTouchStart(event) {
    touchStartX = event.changedTouches[0].clientX
  }

  /** Treat a horizontal drag as a day change, the way a photo viewer would. */
  function onTouchEnd(event) {
    const travelled = event.changedTouches[0].clientX - touchStartX
    if (Math.abs(travelled) < SWIPE_THRESHOLD) return
    if (travelled < 0 && day >= today()) return
    day = shiftDay(day, travelled < 0 ? 1 : -1)
  }

  const projects = $derived(new Map(($projectStore ?? []).map((p) => [p.id, p])))

  /**
   * Every span falling on this day, in one lane per group.
   *
   * A span always keeps its own project's colour, whichever grouping is in
   * force: the lane says which tag, the colour still says which project, so
   * grouping by tag loses no information here the way a summed bar would.
   */
  const lanes = $derived.by(() => {
    const offsets = dayOffsets($timeEntries)
    const byGroup = new Map()
    for (const entry of $timeEntries) {
      const project = projects.get(entry.project_id)
      // Archived projects leave the patterns page, as they do the totals; the
      // record and the export still hold their sessions.
      if (!project || !project.active) continue
      const keys =
        by === 'tag'
          ? project.tags.length
            ? project.tags.map((tag) => tag.id)
            : [null]
          : [project.id]

      for (const slice of slices(entry, $now, offsets)) {
        if (!shown.includes(slice.day) || slice.to <= slice.from) continue
        // A lane is a day when several are shown, and a group when one is.
        for (const key of byDay ? [slice.day] : keys) {
          if (!byGroup.has(key)) byGroup.set(key, [])
          byGroup.get(key).push({ ...slice, entry, project })
        }
      }
    }

    const named = new Map(($tagStore ?? []).map((tag) => [tag.id, tag]))
    const describe = (key) => {
      if (byDay) return { label: dayLabel(key), colour: null }
      if (by === 'tag') {
        return {
          label: named.get(key)?.name ?? 'Untagged',
          colour: named.get(key)?.colour ?? 'haze',
        }
      }
      return {
        label: projects.get(key)?.name ?? '',
        colour: projects.get(key)?.colour ?? 'haze',
      }
    }

    const lanes = [...byGroup.entries()].map(([key, spans]) => ({
      key,
      ...describe(key),
      spans: spans.toSorted((a, b) => a.from - b.from),
      total: spans.reduce((sum, span) => sum + span.seconds, 0),
    }))
    // Days read in calendar order; groups read in the order the day happened.
    return byDay
      ? lanes.toSorted((a, b) => String(a.key).localeCompare(String(b.key)))
      : lanes.toSorted((a, b) => a.spans[0].from - b.spans[0].from)
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

  const isToday = $derived(!byDay && day === today())

  /** Seconds since local midnight, for the "now" marker. */
  const nowSeconds = $derived.by(() => {
    const at = new Date($now)
    return at.getHours() * HOUR + at.getMinutes() * 60 + at.getSeconds()
  })

  // Read, never owned: see `lib/resource.svelte.js` for why a component that
  // cannot assign its own loading state cannot loop.
  const loaded = resource(
    () => ({ from: shown[0], to: shown.at(-1) }),
    ({ from, to }) =>
      Promise.all([
        ensureProjects(),
        ensureTags(),
        ensureTimeEntries({
          start: shiftDay(from, -NEIGHBOURS),
          end: shiftDay(to, NEIGHBOURS),
        }),
      ]),
    { name: 'timeline' }
  )

  const loading = $derived(loaded.loading && lanes.length === 0)
</script>

<p class="meta mb-3 normal-case">{formatDuration(tracked)} tracked</p>

{#if loading}
  <p class="meta">Loading…</p>
{:else if lanes.length === 0}
  <p class="rounded-xl border border-white/10 bg-ink-soft px-5 py-8 text-haze">
    Nothing tracked on this day.
  </p>
{:else}
  <!-- Swipe changes the day, as it does in the records. -->
  <div
    class="rounded-xl border border-white/10 bg-ink-soft p-4"
    data-timeline={day}
    ontouchstart={onTouchStart}
    ontouchend={onTouchEnd}
  >
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
            {#if lane.colour}
              <span
                class="size-2.5 shrink-0 rounded-full"
                style:background="var(--color-{lane.colour}, var(--color-dusk-lift))"
              ></span>
            {/if}
            <span class="truncate text-sm font-medium">{lane.label}</span>
          </span>
          <span class="meta numeral ml-4.5 block">{formatDuration(lane.total)}</span>
        </span>

        <div
          class="relative h-10 overflow-hidden rounded-md border border-white/5 bg-ink"
          data-lane={lane.key}
        >
          {#each ticks as tick (tick)}
            <span
              class="absolute inset-y-0 w-px bg-white/5"
              style:left="{position(tick)}%"
            ></span>
          {/each}

          {#each lane.spans as span_ (span_.entry.id + span_.from)}
            <!-- A quarter-hour session is a sliver at day scale, so every bar
                 keeps a floor width: a session that happened must be visible. -->
            {@const drawnTo = Math.min(span_.to, window.to)}
            {@const clipped = span_.to > window.to}
            <span
              class="absolute inset-y-1 rounded-sm {clipped ? 'rounded-r-none' : ''}"
              style:left="{position(span_.from)}%"
              style:width="{Math.max(0, position(drawnTo) - position(span_.from))}%"
              style:min-width="3px"
              style:background="var(--color-{span_.project
                .colour}, var(--color-dusk-lift))"
              style:opacity={span_.entry.ended_at ? 0.85 : 1}
              title="{span_.project.name} · {clockOfSeconds(span_.from)}–{span_.entry.ended_at
                ? clockOfSeconds(span_.to)
                : 'running'} · {formatDuration(span_.seconds)}{clipped
                ? ' · runs past the end of this day'
                : ''}"
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
    <span class="sm:hidden">Swipe to change day. </span>
    {#if !fullDay}
      {clockOfSeconds(window.from)}–{clockOfSeconds(window.to === DAY_SECONDS ? 0 : window.to)}.
    {/if}
    {#if lanes.length > 1}
      Overlapping lanes ran at once.
    {/if}
  </p>
{/if}
