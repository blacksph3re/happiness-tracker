<script>
  import Frame from '../../lib/Frame.svelte'
  import { clockOfSeconds, formatDuration, formatSigned } from '../../lib/clock.js'
  import { currentDay, dayLabel, today, WEEKDAY_LABELS } from '../../lib/day.js'
  import { period, stepPeriod } from '../../lib/period.js'
  import { resource } from '../../lib/resource.svelte.js'
  import { query } from '../../lib/router.js'
  import {
    ensurePreferences,
    ensureProjects,
    ensureTagRules,
    ensureTags,
    ensureTimeEntries,
    persistPreferences,
    preferenceSection,
    preferences,
    projects as projectStore,
    tagRules,
    tags as tagStore,
    timeEntries,
  } from '../../lib/store.js'
  import { ALLOWANCE, allocateWeek, BOUNDS, daySpan, hasCap, STEPS } from '../../lib/time/allocate.js'
  import { trackedFor } from '../../lib/time/budget.js'
  import { COLUMN } from '../../lib/time/column.js'
  import { dayOffsets, slices } from '../../lib/time/duration.js'

  /**
   * One week of a tag, as tracked beside its optimal allocation.
   *
   * Nothing here is stored or written but the choice of step: the allocation is
   * worked out on the device by `allocateWeek` from the week's per-day tracked
   * time and the tag's rule, and the right-hand side is headed as not what was
   * tracked. It feeds no total, no budget and no export.
   */

  const loaded = resource(
    () => true,
    () =>
      Promise.all([
        ensureProjects(),
        ensureTags(),
        ensureTagRules(),
        ensureTimeEntries(),
        ensurePreferences(),
      ]),
    { name: 'allocation' }
  )

  /** Tags whose rule deducts anything: the only ones there is something to allocate for. */
  const ruled = $derived(
    ($tagStore ?? []).filter((tag) => ($tagRules ?? {})[tag.id]?.bands?.length)
  )

  /** The tag shown: the one named in the address, one picked here, or the first with a cap. */
  let picked = $state(Number($query.get('tag')) || null)
  const tagId = $derived(
    ruled.some((tag) => tag.id === picked)
      ? picked
      : ((ruled.find((tag) => hasCap(($tagRules ?? {})[tag.id])) ?? ruled[0])?.id ?? null)
  )
  const rule = $derived(tagId === null ? null : ($tagRules ?? {})[tagId])

  /** The week shown, by any day in it; this week until the address names one. */
  let anchor = $state($query.get('week') || today())
  const week = $derived(period('week', anchor))
  const atLatest = $derived($currentDay >= week.start && $currentDay <= week.end)

  /** Minutes, quarter hours, half hours or whole hours, per account, in a section of its own. */
  const section = $derived(preferenceSection($preferences, 'allocation'))
  const unit = $derived(Object.hasOwn(STEPS, section.step) ? section.step : 'minute')

  function chooseUnit(value) {
    persistPreferences('allocation', { ...section, step: value })
  }

  /** How a day's times are written: as tracked, or laid from its start or its end. */
  const bounds = $derived(BOUNDS.includes(section.bounds) ? section.bounds : 'natural')

  function chooseBounds(value) {
    persistPreferences('allocation', { ...section, bounds: value })
  }

  /** A span's text, the time a mode moved in brackets as on Record. */
  function spanText({ from, to, fromAdjusted, toAdjusted }) {
    const written = (seconds, adjusted) =>
      adjusted ? `(${clockOfSeconds(seconds)})` : clockOfSeconds(seconds)
    return `${written(from, fromAdjusted)} – ${written(to, toAdjusted)}`
  }

  /**
   * The week's days that are over and held time for the tag: what it tracked,
   * and when its first session began and its last one ended.
   *
   * Tracked time is the budget's (`trackedFor`), archived projects included.
   * Today is left out until it is over, like every other figure built on days.
   */
  const days = $derived.by(() => {
    if (tagId === null) return []
    const projects = $projectStore ?? []
    const entries = $timeEntries ?? []
    const asOf = Date.now()
    const tracked = trackedFor(tagId, entries, projects, asOf)
    // The tag's live projects: an archived one's sessions neither count nor
    // stretch a day's start and end.
    const inTag = new Set(
      projects
        .filter((project) => project.active && project.tags?.some((tag) => tag.id === tagId))
        .map((p) => p.id)
    )
    const offsets = dayOffsets(entries)
    const bounds = new Map()
    for (const entry of entries) {
      if (!inTag.has(entry.project_id)) continue
      for (const slice of slices(entry, asOf, offsets)) {
        if (slice.day < week.start || slice.day > week.end) continue
        const held = bounds.get(slice.day)
        bounds.set(slice.day, {
          start: Math.min(held?.start ?? Infinity, slice.from),
          end: Math.max(held?.end ?? -Infinity, slice.to),
        })
      }
    }
    return [...bounds.keys()]
      .filter((day) => day < $currentDay && (tracked[day] ?? 0) > 0)
      .toSorted()
      .map((day) => ({ day, tracked: tracked[day], ...bounds.get(day) }))
  })

  const allocation = $derived(
    rule && days.length
      ? allocateWeek({ days, rule, step: STEPS[unit], allowance: ALLOWANCE[unit] })
      : null
  )

  /** Nothing to show yet because nothing has been read, not because there is nothing. */
  const loading = $derived(loaded.loading && ($timeEntries ?? []).length === 0)

  const startOf = $derived(new Map(days.map((day) => [day.day, day])))

  /** A weekday's short name, for a move inside one week. */
  function weekday(day) {
    return WEEKDAY_LABELS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]
  }

  /** One move, in the words the list uses. */
  function said(move) {
    const what = move.kind === 'addition' ? `+${formatDuration(move.seconds)} addition` : `${short(move.seconds)} tracked`
    return `${what}: ${weekday(move.from)} → ${weekday(move.to)}`
  }

  /** A transfer's size without a zero hour in front of minutes: `1m`, `2h 31m`. */
  function short(seconds) {
    const minutes = Math.round(seconds / 60)
    return minutes < 60 ? `${minutes}m` : formatDuration(seconds)
  }

  /** Whether a day gave or took anything. */
  const changed = $derived(
    new Set(
      (allocation?.moves ?? []).flatMap((move) => [move.from, move.to])
    )
  )
</script>

<Frame column={COLUMN}>
<section>
  <p class="meta">The week, rearranged</p>
  <h1 class="mt-1 mb-6 text-3xl font-bold tracking-tight">Allocation</h1>

  {#if ruled.length > 1}
    <div class="mb-4 flex flex-wrap gap-1" role="group" aria-label="Tag">
      {#each ruled as tag (tag.id)}
        <button
          class="meta rounded-md border px-4 py-2 transition
                 {tag.id === tagId
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={tag.id === tagId}
          data-allocation-tag={tag.id}
          onclick={() => (picked = tag.id)}
        >
          {tag.name}
        </button>
      {/each}
    </div>
  {/if}

  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <p class="meta" data-period>{week.label}</p>
    <div class="flex gap-2">
      <button class="btn-outline meta" onclick={() => (anchor = stepPeriod('week', anchor, -1))}>
        ← Previous
      </button>
      <button
        class="btn-outline meta disabled:cursor-not-allowed disabled:opacity-30"
        disabled={atLatest}
        onclick={() => (anchor = stepPeriod('week', anchor, 1))}
      >
        Next →
      </button>
    </div>
  </div>

  <!-- Equal cells with one-word labels, two by two on a phone: four in a row
       leave "Quarter" no room there, and a label never breaks. -->
  <div class="mb-6 flex flex-wrap items-center gap-3">
    <p class="meta">Move tracked time by the</p>
    <div
      class="grid w-full grid-cols-2 gap-1 sm:w-auto sm:grid-cols-[repeat(4,6rem)]"
      role="group"
      aria-label="Move tracked time by the"
    >
      {#each [['minute', 'Minute'], ['quarter', 'Quarter'], ['half', 'Half'], ['hour', 'Hour']] as [value, label] (value)}
        <button
          class="meta min-h-11 whitespace-nowrap rounded-md border px-3 transition
                 {unit === value
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={unit === value}
          data-allocation-step={value}
          onclick={() => chooseUnit(value)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  <!-- The pair Record's merged rows write, plus the times as they were. Natural
       widths, wrapping: "Start adjusted" leaves no room for equal cells on a
       phone. -->
  <div class="mb-6 flex flex-wrap items-center gap-3">
    <p class="meta">Times</p>
    <div class="flex flex-wrap gap-1" role="group" aria-label="Times">
      {#each [['natural', 'Natural'], ['start', 'Start adjusted'], ['end', 'End adjusted']] as [value, label] (value)}
        <button
          class="meta min-h-11 whitespace-nowrap rounded-md border px-3 transition
                 {bounds === value
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={bounds === value}
          data-allocation-bounds={value}
          onclick={() => chooseBounds(value)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else if ruled.length === 0}
    <p class="text-haze" data-allocation-blocked>No tag has a deduction rule to allocate for.</p>
  {:else if !hasCap(rule)}
    <p class="text-haze" data-allocation-blocked>
      Needs a cap in the tag's rule: without one, the least deduction is to pile the
      week onto a day or two.
    </p>
  {:else if !allocation}
    <p class="text-haze" data-allocation-empty>
      {atLatest ? 'Nothing tracked on a day of this week that is over.' : 'Nothing tracked this week.'}
    </p>
  {:else}
    <p class="numeral mb-4 text-xl font-semibold" data-allocation-saving>
      Deducted {formatDuration(allocation.deducted.before)} → {formatDuration(allocation.deducted.after)}
    </p>
    {#if allocation.deducted.after - allocation.deducted.least >= 60}
      <!-- The allowance traded a few minutes for fewer moves; the least is not
           hidden for it. -->
      <p class="-mt-2 mb-4 text-sm text-haze" data-allocation-least>
        {`Least possible: ${formatDuration(allocation.deducted.least)}, by moving more.`}
      </p>
    {/if}

    {#if allocation.moves.length}
      <ol class="mb-6 flex list-decimal flex-col gap-1 pl-6">
        {#each allocation.moves as move, index (index)}
          <li class="numeral tabular-nums" data-move>{said(move)}</li>
        {/each}
      </ol>
    {:else}
      <p class="mb-6 text-haze">Nothing to move: no allocation deducts less.</p>
    {/if}

    <!-- Laid out by the room the page has, not the window: a side needs 276px
         (its heading, "Allocated — not what was tracked", with 15% to spare),
         so the sides pair up from 38rem, and the date takes a column of its own
         from 46rem. Half a laptop screen sits between the two. -->
    <div class="@container">
    <div
      class="hidden gap-x-4 px-4 @min-[38rem]:grid @min-[38rem]:grid-cols-2
             @min-[46rem]:grid-cols-[7rem_1fr_1fr]"
      aria-hidden="true"
      data-allocation-sides
    >
      <span class="hidden @min-[46rem]:block"></span>
      <p class="meta whitespace-nowrap">As tracked</p>
      <p class="meta whitespace-nowrap">Allocated — not what was tracked</p>
    </div>
    <ul class="mt-2 flex flex-col gap-2">
      {#each allocation.before as before, index (before.day)}
        {@const after = allocation.after[index]}
        {@const clock = startOf.get(before.day)}
        <li
          class="grid gap-x-4 gap-y-3 rounded-xl border bg-ink-soft px-4 py-3
                 @min-[38rem]:grid-cols-2 @min-[46rem]:grid-cols-[7rem_1fr_1fr]
                 {changed.has(before.day) ? 'border-ember/60' : 'border-white/10'}"
          data-allocation-day={before.day}
          data-changed={changed.has(before.day) ? '' : undefined}
        >
          <p class="meta self-center whitespace-nowrap @min-[38rem]:col-span-2 @min-[46rem]:col-span-1">
            {dayLabel(before.day)}
          </p>
          {#each [['tracked', before], ['allocated', after]] as [side, state] (side)}
            <div class="min-w-0" data-side={side}>
              <p class="meta whitespace-nowrap @min-[38rem]:hidden">
                {side === 'tracked' ? 'As tracked' : 'Allocated — not what was tracked'}
              </p>
              <p class="numeral tabular-nums" data-span>
                {spanText(daySpan(clock, before, state, bounds))}
              </p>
              <p class="text-sm text-haze">
                {formatDuration(state.tracked) +
                  (state.additions ? ` + ${formatDuration(state.added)}` : '') +
                  // Seconds past a cap a minute-wise move could not avoid read as
                  // zero at the app's precision, so they are not written as one.
                  (state.deducted >= 60 ? ` · ${formatSigned(-state.deducted)}` : '')}
              </p>
              <p class="numeral font-semibold tabular-nums" data-reported>
                {formatDuration(state.reported)}
              </p>
            </div>
          {/each}
        </li>
      {/each}
    </ul>
    </div>
  {/if}
</section>
</Frame>
