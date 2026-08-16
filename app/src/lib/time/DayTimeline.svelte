<script>
  import { swipe } from '../swipe.js'
  import { dayLabel, shiftDay, today } from '../day.js'
  import { clockOfSeconds, dayOffsets, formatDuration, slices } from './duration.js'
  import { now } from './tick.js'
  import { resource } from '../resource.svelte.js'
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


  /**
   * What the pointer is over, and where to put the label for it.
   *
   * A `title` attribute was doing this job, and doing it badly: the browser
   * waits about a second before showing one, shows it wherever it likes, and on
   * a phone never shows it at all. The charts on the same page answer instantly
   * through their own tooltip, so this is the same answer in the same shape.
   */
  let hovered = $state(null)

  /** Describe a span the way the chart tooltips describe a point. */
  function label(span) {
    const clock = `${clockOfSeconds(span.from)}–${
      span.entry.ended_at ? clockOfSeconds(span.to) : 'running'
    }`
    const spill = span.to > window.to ? ' · runs past the end of this day' : ''
    return {
      name: span.project.name,
      detail: `${clock} · ${formatDuration(span.seconds)}${spill}`,
    }
  }

  /**
   * Whether the label is held open by a tap rather than by the pointer.
   *
   * A finger has no hover: it arrives, and then it is gone. ECharts answers a
   * tap by leaving the tooltip up until something else is tapped, so a lane
   * does the same — otherwise the label flashes for exactly as long as the
   * finger is down, which is how "hovering does not work on mobile" looks.
   */
  let pinned = $state(false)

  function follow(span, event) {
    // A mouse leaving un-pins; a pointer that never hovers cannot, so a tap
    // elsewhere is what closes a pinned label. See the window handler below.
    if (event.pointerType !== 'mouse') pinned = true
    hovered = { ...label(span), x: event.clientX, y: event.clientY }
  }

  /** Track the pointer without re-pinning, so a mouse move stays a hover. */
  function drift(span, event) {
    if (event.pointerType === 'mouse') follow(span, event)
  }

  function release(event) {
    if (event.pointerType === 'mouse' && !pinned) hovered = null
  }

  const projects = $derived(new Map(($projectStore ?? []).map((p) => [p.id, p])))

  // `globalThis`, not `window`: this component declares a `window` of its own —
  // the stretch of the day the axis covers — and reaching for `addEventListener`
  // on that one throws where the whole timeline renders.
  //
  // Captured, so it runs before the span's own handler can re-pin: a tap that
  // lands on another block should move the label rather than close it.
  $effect(() => {
    const put = () => {
      pinned = false
      hovered = null
    }
    const dismiss = (event) => {
      if (!pinned) return
      // The label itself counts as elsewhere: tapping it is how it is put away.
      if (event.target?.closest?.('[data-span]')) return
      put()
    }
    // A pinned label is positioned against the viewport, so scrolling would
    // otherwise carry it down the page over blocks it no longer describes —
    // stuck to the screen with no way left to be rid of it. Scrolling is a
    // clear enough "moved on", so it goes.
    const leave = () => {
      if (pinned) put()
    }
    globalThis.addEventListener('pointerdown', dismiss, true)
    globalThis.addEventListener('scroll', leave, { capture: true, passive: true })
    return () => {
      globalThis.removeEventListener('pointerdown', dismiss, true)
      globalThis.removeEventListener('scroll', leave, { capture: true })
    }
  })

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
        byGroup.get(key).push({ ...slice, entry, project })
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

          <!-- Keyed on the identity the device gave the session, not on the row
               id: a session recorded here has no row id until it syncs, so two
               of them in one lane would both key as `undefined` — and Svelte
               refuses duplicate keys by throwing, mid-render, leaving half the
               page showing the window it was on before. -->
          {#each lane.spans as span_ (`${span_.entry.client_id ?? span_.entry.id}:${span_.from}`)}
            <!-- A quarter-hour session is a sliver at day scale, so every bar
                 keeps a floor width: a session that happened must be visible. -->
            {@const drawnTo = Math.min(span_.to, window.to)}
            {@const clipped = span_.to > window.to}
            <!-- Pointer events rather than mouse ones, so a tap answers on a
                 phone too — where a `title` never appeared at all. The span is
                 not focusable and carries an `aria-label` instead: it is a
                 picture of data that is also listed as text beside it. -->
            <span
              role="img"
              aria-label="{span_.project.name} · {label(span_).detail}"
              data-span={span_.entry.client_id ?? span_.entry.id}
              class="absolute inset-y-1 rounded-sm {clipped ? 'rounded-r-none' : ''}"
              style:left="{position(span_.from)}%"
              style:width="{Math.max(0, position(drawnTo) - position(span_.from))}%"
              style:min-width="3px"
              style:background="var(--color-{span_.project
                .colour}, var(--color-dusk-lift))"
              style:opacity={span_.entry.ended_at ? 0.85 : 1}
              onpointerdown={(event) => follow(span_, event)}
              onpointerenter={(event) => drift(span_, event)}
              onpointermove={(event) => drift(span_, event)}
              onpointerleave={release}
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

  <!-- Fixed to the viewport, not to the lane: a lane clips its own overflow, so
       anything positioned inside it would be cut off at the edges — which is
       where a tooltip is most often needed. Translated up and right of the
       pointer, and inert, so it can never sit between the pointer and the bar
       it is describing. -->
  {#if hovered}
    <!-- Inert while it follows a pointer, so it can never sit between the
         cursor and the block it describes; tappable once pinned, or a tap meant
         to dismiss it would fall through onto the block underneath and pin it
         all over again. -->
    <div
      data-span-tip
      class="fixed z-50 max-w-64 rounded-md bg-paper px-3 py-2 text-xs leading-snug
             text-ink shadow-lg {pinned ? 'pointer-events-auto' : 'pointer-events-none'}"
      style:left="{hovered.x + 12}px"
      style:top="{hovered.y - 12}px"
      style:transform="translateY(-100%)"
    >
      <span class="block font-semibold">{hovered.name}</span>
      <span class="block text-ink/70">{hovered.detail}</span>
    </div>
  {/if}

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
