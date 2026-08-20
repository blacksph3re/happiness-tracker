<script>
  import { swipe } from '../swipe.js'
  import { dayLabel, shiftDay, today } from '../day.js'
  import { clockOfSeconds, formatDuration } from '../clock.js'
  import { dayOffsets, slices } from './duration.js'
  import { now } from './tick.js'
  import { resource } from '../resource.svelte.js'
  import Swimlanes from '../Swimlanes.svelte'
  import {
    ensureProjects,
    ensureTimeEntries,
    projects as projectStore,
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
  // A list means a run of days, however short the list turns out to be. It once
  // meant "more than one", which read correctly until a filter narrowed a week
  // to a single day: the strip fell back to lanes-per-project for whichever day
  // the window happened to be anchored on, which was rarely the day that
  // matched.
  const byDay = $derived(Array.isArray(days))
  const shown = $derived(byDay ? days : [day])

  const DAY_SECONDS = 86_400
  const HOUR = 3600

  /** Days either side of the one shown that are fetched with it, so stepping is free. */
  const NEIGHBOURS = 3


  const projects = $derived(new Map(($projectStore ?? []).map((p) => [p.id, p])))

  /**
   * Every span falling on this day, in one lane per project — or per day, when
   * a run of them is shown.
   */
  const lanes = $derived.by(() => {
    const offsets = dayOffsets($timeEntries)
    const byGroup = new Map()
    for (const entry of $timeEntries) {
      const project = projects.get(entry.project_id)
      // Archived projects leave the patterns page, as they do the totals; the
      // record and the export still hold their sessions.
      if (!project || !project.active) continue
      for (const slice of slices(entry, $now, offsets)) {
        if (!shown.includes(slice.day) || slice.to <= slice.from) continue
        // A lane is a day when several are shown, and a project when one is.
        const key = byDay ? slice.day : project.id
        if (!byGroup.has(key)) byGroup.set(key, [])
        const clock = `${clockOfSeconds(slice.from)}–${
          entry.ended_at ? clockOfSeconds(slice.to) : 'running'
        }`
        byGroup.get(key).push({
          // Keyed on the identity the device gave the session, not the row id:
          // one recorded here has no row id until it syncs, and two of those in
          // a lane would both key as `undefined`.
          key: `${entry.client_id ?? entry.id}:${slice.from}`,
          from: slice.from,
          to: slice.to,
          seconds: slice.seconds,
          colour: project.colour,
          name: project.name,
          detail: `${clock} · ${formatDuration(slice.seconds)}`,
          faded: false,
        })
      }
    }

    const describe = (key) =>
      byDay
        ? { label: dayLabel(key), colour: null }
        : {
            label: projects.get(key)?.name ?? '',
            colour: projects.get(key)?.colour ?? 'haze',
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
      // A run of days can be empty — a filter narrowing a week to a weekday it
      // does not contain leaves nothing at all — and a range with no ends is
      // not a range. Asking anyway threw inside `shiftDay`, mid-render, which
      // left the page half drawn behind an exception rather than showing the
      // empty week it was asked for.
      from === undefined
        ? ensureProjects()
        : Promise.all([
            ensureProjects(),
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
    Nothing tracked on {byDay ? 'these days' : 'this day'}.
  </p>
{:else}
  <!-- Swipe changes the day, as it does in the records. Previous and Next do
       the same thing as buttons, so the gesture stays an enhancement. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rounded-xl border border-white/10 bg-ink-soft p-4"
    data-timeline={day}
    use:swipe={{
      onswipe: (delta) => (day = shiftDay(day, delta)),
      forward: () => day < today(),
    }}
  >
    <Swimlanes {lanes} {window} marker={isToday ? nowSeconds : null} />
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
