<script>
  import { dayLabel, shiftDay, today } from '../../lib/day.js'
  import { clockLabel, clockOfSeconds, formatDuration, localDay } from '../../lib/clock.js'
  import { period, stepPeriod, daysIn } from '../../lib/period.js'
  import { now } from '../../lib/time/tick.js'
  import { chart } from '../../lib/chart-action.js'
  import Swimlanes from '../../lib/Swimlanes.svelte'
  import {
    RUNNING,
    dayTotals,
    effectiveEnd,
    pomodoroState,
    splitSeconds,
  } from '../../lib/pomodoro/derive.js'
  import { weekOptions } from '../../lib/pomodoro/charts.js'
  import { ensurePomodoros, pomodoros as pomodoroStore } from '../../lib/store.js'

  /**
   * What the focus half adds up to, over a day or a week.
   *
   * The day answers "what did today look like", the week "how much and how
   * often" — which is the pair every other patterns page here offers, and the
   * reason this one was useless before: a single day's strip cannot show a
   * habit.
   */

  const HOUR = 3600

  /**
   * How much of a day one lane covers, before a pomodoro is pushed to the next.
   *
   * Two hours, which is four pomodoros at 25/5. The strip used to stretch the
   * whole working day across one lane, where a 25-minute block was a sliver a
   * few pixels wide.
   *
   * It decides where a lane *breaks*, not where the axis ends. A pomodoro that
   * begins inside the two hours belongs to that lane however far past the mark
   * it runs — the axis stretches to hold it instead, for every lane at once, so
   * the rows stay comparable. Cutting one in half would be the picture lying
   * about how long it was.
   */
  const LANE_SECONDS = 2 * HOUR

  /** A little air past the last block, so a full row does not end flush. */
  const LANE_MARGIN = 300

  let unit = $state('day')
  let anchor = $state(today())

  const shown = $derived(period(unit, anchor))

  /** `period` labels a day with its raw key; everywhere else reads a heading. */
  const heading = $derived(unit === 'day' ? dayLabel(anchor, { withYear: true }) : shown.label)
  const days = $derived(daysIn(unit, anchor).filter((day) => day <= today()))
  const atLatest = $derived(today() >= shown.start && today() <= shown.end)

  // Read from the store, not snapshotted out of the loader: stepping to a
  // window already held must paint from what is there rather than wait.
  const rows = $derived(
    ($pomodoroStore ?? [])
      .map((row) => ({ row, day: localDay(row.started_at, row.utc_offset) }))
      .filter(({ day }) => day >= shown.start && day <= shown.end)
      .toSorted((a, b) => a.row.started_at.localeCompare(b.row.started_at))
  )

  const finished = $derived(
    rows.map(({ row }) => row).filter((row) => pomodoroState(row, $now) !== RUNNING)
  )
  const totals = $derived(dayTotals(finished, $now))

  $effect(() => {
    ensurePomodoros({ start: shown.start, end: shown.end })
  })

  /** Seconds since local midnight for a stored UTC instant and its offset. */
  function secondsIntoDay(iso, offsetMinutes) {
    const local = new Date(Date.parse(`${iso}Z`) + offsetMinutes * 60_000)
    return local.getUTCHours() * HOUR + local.getUTCMinutes() * 60 + local.getUTCSeconds()
  }

  /**
   * The day's pomodoros wrapped into lanes of at most four.
   *
   * A lane starts over when it is full, or when the next pomodoro begins more
   * than a lane's width after the one that opened it — so a morning block and
   * an afternoon block are two rows rather than one row with an hour of empty
   * axis in the middle.
   *
   * Every lane is drawn against the *same* axis, zero to two hours, so its
   * spans are offsets from its own opening rather than clock times. The lane's
   * label carries the real time it started.
   */
  const lanes = $derived.by(() => {
    if (unit !== 'day' || !finished.length) return []
    const built = []
    let current = null

    for (const row of finished) {
      const at = secondsIntoDay(row.started_at, row.utc_offset)
      // On its start alone: a pomodoro that began inside the window stays in
      // the lane, and one that began after it opens a new one.
      if (!current || at - current.origin >= LANE_SECONDS) {
        current = { key: `${row.client_id ?? row.id}`, origin: at, spans: [], total: 0 }
        built.push(current)
      }
      const split = splitSeconds(row)
      const from = at - current.origin
      const name = row.task ?? 'no task description'
      const clock = clockLabel(row.started_at, row.utc_offset)
      current.spans.push({
        key: `${row.client_id ?? row.id}:focus`,
        from,
        to: from + split.focus,
        colour: row.tainted ? 'alarm' : 'dusk-lift',
        name,
        detail:
          `${clock} · focus ${formatDuration(split.focus)}` +
          `${row.tainted ? ' · tainted' : ''}` +
          `${pomodoroState(row, $now) === 'abandoned' ? ' · abandoned' : ''}`,
      })
      if (split.rest > 0) {
        current.spans.push({
          key: `${row.client_id ?? row.id}:break`,
          from: from + split.focus,
          to: from + split.focus + split.rest,
          colour: 'sage',
          name,
          detail: `break ${formatDuration(split.rest)}`,
          faded: true,
        })
      }
      current.total += split.focus + split.rest
    }

    return built.map((lane) => ({
      key: lane.key,
      label: clockOfSeconds(lane.origin),
      colour: null,
      total: lane.total,
      spans: lane.spans,
    }))
  })

  /**
   * How wide every lane is drawn.
   *
   * The furthest any lane reaches, never less than the two-hour window — so a
   * pomodoro that overruns the mark stretches all the rows rather than being
   * clipped on its own.
   */
  const laneWindow = $derived.by(() => {
    const furthest = Math.max(
      LANE_SECONDS,
      ...lanes.flatMap((lane) => lane.spans.map((span) => span.to)),
      0
    )
    return { from: 0, to: furthest + LANE_MARGIN }
  })

  /**
   * One point per day of the window, for the week chart.
   *
   * Empty days are trimmed from the **ends** only. A weekend with nothing on it
   * is two columns of zero saying "this is where the week stopped", which is
   * not a finding; a Wednesday off in the middle of a working week is, so the
   * interior keeps its gaps.
   */
  const series = $derived.by(() => {
    if (unit === 'day') return null
    const counted = new Map(days.map((day) => [day, { count: 0, focus: 0, rest: 0 }]))
    for (const { row, day } of rows) {
      const bucket = counted.get(day)
      if (!bucket || pomodoroState(row, $now) === RUNNING) continue
      const split = splitSeconds(row)
      bucket.count += 1
      bucket.focus += split.focus
      bucket.rest += split.rest
    }

    let first = 0
    let last = days.length - 1
    while (first <= last && counted.get(days[first]).count === 0) first += 1
    while (last >= first && counted.get(days[last]).count === 0) last -= 1
    const kept = first > last ? [] : days.slice(first, last + 1)

    const asHours = (seconds) => Math.round((seconds / HOUR) * 100) / 100
    return {
      labels: kept.map((day) => dayLabel(day).replace(/,.*/, '')),
      counts: kept.map((day) => counted.get(day).count),
      focus: kept.map((day) => asHours(counted.get(day).focus)),
      breaks: kept.map((day) => asHours(counted.get(day).rest)),
    }
  })

  /** Days in the window on which anything was recorded. */
  const activeDays = $derived(new Set(rows.map(({ day }) => day)).size)
</script>

<section class="mx-auto w-full max-w-3xl px-5 py-10">
  <p class="meta">Focus</p>
  <h1 class="mt-1 text-3xl font-bold tracking-tight">{heading}</h1>

  <div class="mt-6 flex flex-wrap items-center gap-2">
    {#each [['day', 'Day'], ['week', 'Week']] as [value, label] (value)}
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
    <span class="ml-auto flex gap-2">
      <button
        class="meta rounded-md border border-white/20 px-3 py-2 transition hover:border-white/40"
        aria-label="Previous"
        onclick={() => (anchor = stepPeriod(unit, anchor, -1))}
      >
        ←
      </button>
      <button
        class="meta rounded-md border border-white/20 px-3 py-2 transition
               hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Next"
        disabled={atLatest}
        onclick={() => (anchor = stepPeriod(unit, anchor, 1))}
      >
        →
      </button>
    </span>
  </div>

  <div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4" data-focus-totals>
    <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
      <p class="meta">Pomodoros</p>
      <p class="numeral mt-1 text-2xl">{totals.count}</p>
    </div>
    <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
      <p class="meta">Focus</p>
      <p class="numeral mt-1 text-2xl">{formatDuration(totals.focus)}</p>
    </div>
    <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
      <p class="meta">Break</p>
      <p class="numeral mt-1 text-2xl">{formatDuration(totals.rest)}</p>
    </div>
    <div class="rounded-xl border border-white/10 bg-ink-soft p-4">
      <p class="meta">{unit === 'day' ? 'Tainted' : 'Days'}</p>
      <p class="numeral mt-1 text-2xl">
        {unit === 'day' ? formatDuration(totals.tainted) : activeDays}
      </p>
    </div>
  </div>

  {#if unit === 'week'}
    {#if totals.count > 0}
      <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-4">
        <!-- Keyed on the window so the canvas is rebuilt rather than tweened
             between two unrelated weeks. -->
        {#key shown.start}
          <div class="h-72 w-full" data-week-chart use:chart={weekOptions(series)}></div>
        {/key}
      </div>
      <p class="meta mt-3 normal-case">
        {(totals.count / Math.max(1, activeDays)).toFixed(1)} a day on the
        {activeDays === 1 ? 'day' : 'days'} you focused.
      </p>
    {:else}
      <p class="mt-6 text-haze">Nothing recorded this week.</p>
    {/if}
  {:else if lanes.length}
    <div class="mt-6">
      <p class="meta">The day, two hours to a row</p>
      <div class="mt-3 rounded-xl border border-white/10 bg-ink-soft p-4" data-focus-strip>
        <Swimlanes {lanes} window={laneWindow} />
      </div>
      <p class="meta mt-3 normal-case">
        Each row starts at the time on its left. The green part of a block is
        its break.
      </p>
    </div>
  {:else}
    <p class="mt-6 text-haze">Nothing recorded on this day.</p>
  {/if}
</section>
