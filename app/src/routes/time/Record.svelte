<script>
  import { attempt, unwrap } from '../../lib/api.js'
  import {
    createTimeEntry,
    deleteTimeEntry,
    exportTime,
    updateTimeEntry,
  } from '../../lib/generated/sdk.gen'
  import { tick } from 'svelte'

  import { dayLabel, shiftDay, today } from '../../lib/day.js'
  import { link } from '../../lib/router.js'
  import { period, weekHeading } from '../../lib/time/period.js'
  import { offsetLabel } from '../../lib/time/duration.js'
  import { resource } from '../../lib/resource.svelte.js'
  import {
    clockLabel,
    dayOffsets,
    clockOfSeconds,
    formatDuration,
    fromLocal,
    localDay,
    nowUtc,
    slices,
    utcOffset,
  } from '../../lib/time/duration.js'
  import TimeField from '../../lib/time/TimeField.svelte'
  import { now } from '../../lib/time/tick.js'
  import {
    ensureProjects,
    ensureSummary,
    ensureTags,
    ensureTimeEntries,
    ensureTrackedRange,
    forgetEntry,
    projects as projectStore,
    rememberEntry,
    tags as tagStore,
    timeEntries,
    trackedDays,
  } from '../../lib/store.js'
  import { pushToast } from '../../lib/toasts.js'

  /**
   * Every tracked day in one scroll, and the place a session is corrected.
   *
   * A session crossing midnight is drawn on both days it touches, clipped to
   * each — the same division the totals use, so the reading and the arithmetic
   * agree. Editing always works on the whole session, never on a slice.
   */

  /** How much further back one scroll to the foot of the list reaches. */
  const WEEKS_PER_PAGE = 4

  const WEEK_MS = 604_800_000

  let weeksBack = $state(WEEKS_PER_PAGE)
  let editing = $state(null)
  let adding = $state(null)
  let merged = $state(false)

  /** `project` or `tag` — what a row stands for, as on the patterns page. */
  let by = $state('project')

  /**
   * Bumped by every write, to re-read totals the server owns.
   *
   * The session cache updates itself from what a write returns, but the tag
   * totals are computed server-side and only invalidated there — without this a
   * session added while reading by tag would not appear until the window moved.
   */
  let revision = $state(0)

  /**
   * Whether a row can be worked on rather than only read.
   *
   * Merged, a row stands for several sessions; by tag, a row is a whole day of
   * a tag. Offering Edit and Delete on either would offer something the row
   * cannot honestly carry out on its own.
   */
  const workable = $derived(!merged && by === 'project')

  /**
   * A write the server refused because it overlaps, held for the answer.
   *
   * The overlap is not a failure to report and forget: the two likely
   * intentions — "these are one session" and "I mistyped" — are both one tap
   * away, and the merge is a single atomic write rather than a delete and an
   * edit that could half-happen.
   */
  let clash = $state(null)

  const projects = $derived(new Map(($projectStore ?? []).map((p) => [p.id, p])))

  // A session is recorded against a project, so with none there is nothing this
  // page can show and nothing it can add. Empty weeks and an add button that
  // opens a form with an empty picker is a worse answer than saying so.
  const hasProjects = $derived(($projectStore ?? []).length > 0)

  // Today until the tracked range loads, and again after a write clears it. The
  // safe answer while it is unknown, because it makes the list look finished:
  // nothing reaches further back on a guess.
  const historyStart = $derived($trackedDays?.first ?? today())

  /**
   * How many weeks the list may hold at most.
   *
   * The point is to end on the week holding the oldest session rather than on
   * however many empty dividers a page overshot by. Two things keep it from
   * cutting into the list instead: it does not apply while the tracked range is
   * unknown — a write clears it, and clamping to a guess would collapse the
   * list to the current week — and it never trims the four weeks the page opens
   * with, which are the record of a quiet fortnight rather than empty overshoot.
   *
   * Unknown pulls the *opposite* way here to `historyStart` above, and both are
   * the cautious direction of their own question: do not fetch on a guess, do
   * not hide on one either.
   */
  const limit = $derived(
    $trackedDays?.first
      ? Math.max(WEEKS_PER_PAGE, weeksTo($trackedDays.first))
      : Number.POSITIVE_INFINITY
  )

  /**
   * The weeks on screen, newest first.
   *
   * Whole weeks, so a divider never totals a week it holds only part of.
   */
  const weeks = $derived(
    Array.from({ length: Math.min(weeksBack, limit) }, (_, index) =>
      period('week', shiftDay(today(), -7 * index))
    )
  )

  const windowStart = $derived(weeks.at(-1).start)

  /** Whether the window already reaches the first day ever tracked. */
  const atStart = $derived(windowStart <= historyStart)

  const loaded = resource(
    () => ({ start: windowStart, end: today() }),
    (range) =>
      Promise.all([
        ensureProjects(),
        ensureTags(),
        ensureTrackedRange(),
        ensureTimeEntries(range),
      ]),
    { name: 'time record' }
  )

  /**
   * A day's totals per tag, after each tag's rule, as the server works them out.
   *
   * Read rather than derived, and only in tag mode: a deduction belongs to a
   * whole day of a tag and cannot be divided across the sessions under it, so
   * there is no honest way to compute these from the sessions this page holds.
   * It is also the same call the patterns page makes, so the two cannot
   * disagree about what a tag reports.
   */
  const summary = resource(
    () => ({ grouping: by, start: windowStart, end: today(), revision }),
    ({ grouping, start, end }) =>
      grouping === 'tag'
        ? ensureSummary({ start, end, by: 'tag', as_of: nowUtc() })
        : [],
    { name: 'time record tags', initial: [] }
  )

  const loading = $derived(loaded.loading && $timeEntries.length === 0)

  /** Name and colour for a row's group, whichever grouping is in force. */
  const describe = $derived.by(() => {
    const source = by === 'tag' ? ($tagStore ?? []) : ($projectStore ?? [])
    const known = new Map(source.map((item) => [item.id, item]))
    return (key) => {
      if (key === null) return { name: 'Untagged', colour: 'haze' }
      const item = known.get(key)
      return item ? { name: item.name, colour: item.colour } : { name: 'Removed', colour: 'haze' }
    }
  })

  /**
   * A day's tag rows, from the server's totals.
   *
   * One row per tag per day rather than per session, because that is the unit a
   * tag actually has: sessions belong to projects, a deduction belongs to a
   * whole day of a tag, and a project carrying two tags counts fully toward
   * both. The seconds are what the tag *reports* — a rule that takes half an
   * hour off has already taken it here.
   */
  const tagRows = $derived.by(() => {
    const map = new Map()
    for (const row of summary.data ?? []) {
      if (row.day < windowStart || row.day > today()) continue
      if (!map.has(row.day)) map.set(row.day, [])
      map.get(row.day).push({
        key: `${row.day}:${row.key}`,
        group: row.key,
        seconds: row.reported ?? row.seconds,
        deduction: row.deduction ?? 0,
        daily: true,
        entries: [],
        crosses: false,
        whole: false,
        running: false,
      })
    }
    for (const [day, list] of map) {
      map.set(day, list.toSorted((a, b) => b.seconds - a.seconds))
    }
    return map
  })

  /**
   * Every session's part of every day, as the rows a day lists.
   *
   * One row per session by default. Merged, one row per project per day: the
   * first start, the last end, and — deliberately — the time *tracked* rather
   * than the distance between them. A project worked 09:00–12:00 and
   * 13:00–15:00 reads "09:00 – 15:00 · 5h 00m", because the hour at lunch was
   * not worked. The two numbers disagreeing is the point of merging, so the
   * view says so rather than leaving it to be discovered.
   *
   * By tag the rows come from the server instead — see `tagRows`.
   */
  const byDay = $derived.by(() => {
    if (by === 'tag') return tagRows
    const map = new Map()
    // One clock per day, taken from the session that opened it.
    const offsets = dayOffsets($timeEntries)
    const last = today()
    for (const entry of $timeEntries) {
      const parts = slices(entry, $now, offsets)
      const crosses = parts.length > 1 || parts.some((part) => part.whole)
      for (const slice of parts) {
        if (slice.day < windowStart || slice.day > last) continue
        if (!map.has(slice.day)) map.set(slice.day, [])
        map.get(slice.day).push({ ...slice, entry, crosses, group: entry.project_id })
      }
    }

    for (const [day, list] of map) {
      const rows = merged ? mergeByGroup(list) : list.map(asRow)
      // Latest first, like the days and the weeks around them: the page reads
      // backwards in time all the way down, so a session does not run forwards
      // inside a day that runs the other way.
      map.set(day, rows.toSorted((a, b) => b.from - a.from))
    }
    return map
  })

  const dayTotals = $derived(
    new Map(
      [...byDay].map(([day, rows]) => [
        day,
        rows.reduce((sum, row) => sum + row.seconds, 0),
      ])
    )
  )

  /**
   * The weeks to draw, each with the days it actually holds and their total.
   *
   * Only days with something on them: over an unbounded list an untracked
   * Sunday is a line nobody reads, and the week divider is what keeps the
   * timeline continuous across a fortnight away.
   */
  const listing = $derived(
    weeks.map((week) => {
      const days = [...byDay.keys()]
        .filter((day) => day >= week.start && day <= week.end)
        .toSorted()
        .reverse()
      return {
        start: week.start,
        heading: weekHeading(week.start),
        days,
        seconds: days.reduce((sum, day) => sum + (dayTotals.get(day) ?? 0), 0),
      }
    })
  )

  let sentinel = $state(null)

  /** Whether the last growth was the list feeding itself rather than a scroll. */
  let paged = false

  /**
   * Reach further back: by a page, or by the whole rest of the history.
   *
   * Still at the foot of the list after four more weeks arrived means those
   * weeks did not fill the screen — a stretch with nothing tracked in it. The
   * second growth in a row therefore takes the rest of the history at once:
   * four weeks at a time, four months away is five rounds of re-rendering the
   * whole list to show a reader no new day. Two growths per visit to the foot
   * of the list is the bound. `weeks` is what stops it overshooting.
   */
  function grow() {
    weeksBack = paged ? weeksTo(historyStart) : weeksBack + WEEKS_PER_PAGE
    paged = true
  }

  /**
   * Load more when the foot of the list comes into view.
   *
   * The observer is rebuilt for each window and after each load, and that is
   * the point rather than housekeeping: an `IntersectionObserver` reports a
   * *change*, and "still visible now that four more weeks have arrived" is not
   * one. Observing afresh delivers the current state instead, which is what
   * lets a list too short to scroll — four empty weeks over a year-old history
   * — reach its own data. Both dependencies are needed: a load answered from
   * the store settles too quickly to be seen as a change on its own, and a load
   * that goes to the network moves nothing until it lands.
   *
   * `weeksBack` is written from the callback rather than from the effect body.
   * It is what `windowStart` and so this effect's own dependency are built
   * from, so assigning it while tracking would be the asynchronous cycle
   * `resource()` exists to catch. From the callback the write is untracked, and
   * the re-run it causes is the single re-observe above.
   */
  $effect(() => {
    const target = sentinel
    const busy = loaded.loading
    // Read for its dependency alone, so a new window re-observes — see above.
    windowStart
    if (!target || busy) return
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((entry) => entry.isIntersecting)) grow()
      // Out of view means the reader scrolled away from the foot, so the next
      // arrival there is a fresh request rather than a stalled list.
      else paged = false
    })
    observer.observe(target)
    return () => observer.disconnect()
  })

  /** One session's slice, in the shape a row is drawn from. */
  function asRow(slice) {
    return {
      key: `${slice.entry.id}:${slice.from}:${slice.group}`,
      group: slice.group,
      from: slice.from,
      to: slice.to,
      seconds: slice.seconds,
      entries: [slice.entry],
      crosses: slice.crosses,
      whole: slice.whole ?? false,
      running: slice.entry.ended_at === null,
    }
  }

  /** Collapse a day's slices to one row per group. */
  function mergeByGroup(list) {
    const byGroup = new Map()
    for (const slice of list) {
      const found = byGroup.get(slice.group)
      if (!found) {
        byGroup.set(slice.group, {
          ...asRow(slice),
          key: `merged:${slice.group}`,
        })
        continue
      }
      found.from = Math.min(found.from, slice.from)
      found.to = Math.max(found.to, slice.to)
      // Summed, not measured end to end: the gaps between sessions were not
      // tracked, so counting them would invent time.
      found.seconds += slice.seconds
      found.entries.push(slice.entry)
      found.crosses = found.crosses || slice.crosses
      found.whole = found.whole || (slice.whole ?? false)
      found.running = found.running || slice.entry.ended_at === null
    }
    return [...byGroup.values()]
  }

  /**
   * The clock a day is on, when it differs from the browser's own.
   *
   * Null the rest of the time, which is nearly always: an offset on every day
   * heading would be noise everywhere except the week you travelled.
   */
  function dayClock(day) {
    const held = dayOffsets($timeEntries)[day]
    if (held === undefined || held === utcOffset()) return null
    return offsetLabel(held)
  }

  /** How many weeks the list must hold for `day` to be on it. */
  function weeksTo(day) {
    const from = Date.parse(`${period('week', day).start}T00:00:00Z`)
    const here = Date.parse(`${period('week', today()).start}T00:00:00Z`)
    return Math.round((here - from) / WEEK_MS) + 1
  }

  /**
   * Extend the window back far enough to include `day`.
   *
   * A session recorded six weeks ago while the list reaches four back would
   * otherwise save correctly and appear nowhere at all.
   */
  function reach(day) {
    weeksBack = Math.max(weeksBack, weeksTo(day))
  }

  /** The year the jump control is set to, so it reads back what it did. */
  let jumpTo = $state('')

  /**
   * The years there is anything to jump to, newest first.
   *
   * Only years: everything inside one is a scroll away, and a date picker for
   * "some time in March" was a control asking for more precision than the
   * gesture beside it needs. One year in the list means the list is the whole
   * history, so the control has nothing to offer and is not drawn at all.
   */
  const years = $derived.by(() => {
    const first = Number(historyStart.slice(0, 4))
    const last = Number(today().slice(0, 4))
    return Array.from({ length: last - first + 1 }, (_, index) => last - index)
  })

  /**
   * Reach a year directly, for a stretch too long to be worth scrolling to.
   *
   * Lands on that year's *latest* week, since the list reads backwards: from
   * there, scrolling down carries on through the year rather than out of it.
   * The window is opened to the whole year rather than to the week landed on,
   * so a year whose work stopped in November is not seven empty dividers and
   * another wait before anything appears.
   */
  async function goToYear(year) {
    if (!year) return
    const wanted = Number(year) === Number(today().slice(0, 4)) ? today() : `${year}-12-31`
    const opening = `${year}-01-01`
    reach(opening < historyStart ? historyStart : opening)
    // The dividers are drawn from the window alone, so one flush is enough to
    // scroll to one — the sessions under it can arrive after it is on screen.
    await tick()
    const start = period('week', wanted).start
    document
      .querySelector(`[data-week="${start}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function startEditing(entry) {
    adding = null
    editing = {
      id: entry.id,
      project_id: entry.project_id,
      startDay: localDay(entry.started_at, entry.utc_offset),
      startClock: clockLabel(entry.started_at, entry.utc_offset),
      endDay: entry.ended_at ? localDay(entry.ended_at, entry.utc_offset) : '',
      endClock: entry.ended_at ? clockLabel(entry.ended_at, entry.utc_offset) : '',
      offset: entry.utc_offset,
      running: entry.ended_at === null,
    }
  }

  function startAdding() {
    editing = null
    adding = {
      day: today(),
      project_id: ($projectStore ?? []).find((p) => p.active)?.id ?? null,
      startClock: '09:00',
      endClock: '17:00',
    }
  }

  async function saveEdit(merge = false) {
    const body = {
      project_id: editing.project_id,
      started_at: fromLocal(editing.startDay, editing.startClock, editing.offset),
      merge_overlapping: merge,
    }
    if (!editing.running) {
      body.ended_at = fromLocal(editing.endDay, editing.endClock, editing.offset)
    }
    const saved = await write(
      () => updateTimeEntry({ path: { entry_id: editing.id }, body }),
      () => saveEdit(true)
    )
    if (!saved) return
    rememberEntry(saved)
    revision += 1
    // A merge removes the sessions it swallowed, and the store cannot know
    // which from the one row it gets back.
    if (merge) await ensureTimeEntries({ force: true })
    editing = null
    clash = null
  }

  async function saveNew(merge = false) {
    const offset = utcOffset()
    const day = adding.day
    const created = await write(
      () =>
        createTimeEntry({
          body: {
            project_id: adding.project_id,
            started_at: fromLocal(day, adding.startClock, offset),
            ended_at: fromLocal(day, adding.endClock, offset),
            utc_offset: offset,
            merge_overlapping: merge,
          },
        }),
      () => saveNew(true)
    )
    if (!created) return
    rememberEntry(created)
    revision += 1
    if (merge) await ensureTimeEntries({ force: true })
    reach(day)
    adding = null
    clash = null
  }

  /**
   * Run a write, catching the one refusal that has a good second answer.
   *
   * @param {() => Promise<unknown>} call The write.
   * @param {() => Promise<unknown>} retry The same write, merging.
   */
  async function write(call, retry) {
    try {
      return await unwrap(call)
    } catch (error) {
      if (error.message.includes('overlaps')) {
        clash = { retry }
        return null
      }
      pushToast(error.message)
      return null
    }
  }

  async function remove(entry) {
    // A 204 unwraps to null, which is also what a failure gives back, so this
    // one reads the exception rather than the value.
    try {
      await unwrap(() => deleteTimeEntry({ path: { entry_id: entry.id } }))
    } catch (error) {
      pushToast(error.message)
      return
    }
    forgetEntry(entry.id)
    revision += 1
    editing = null
  }

  async function download() {
    // Everything, not the weeks on screen: the button reads "download", and a
    // range would quietly export however far the list happened to be scrolled.
    // The wellbeing export behaves the same way.
    //
    // A zip, and the label says so: a CSV holds one table and this export is
    // three — the sessions, and the daily totals per project and per tag.
    const file = await attempt(() => exportTime({ parseAs: 'blob' }))
    if (!file) return
    const url = URL.createObjectURL(file)
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: 'tracked-time.zip',
    })
    // Attached and revoked a tick later: revoking synchronously can cancel the
    // download before the browser has read the blob.
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
</script>

<section class="mx-auto w-full max-w-4xl px-5 py-8">
  <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="meta">Every session you have tracked</p>
      <h1 class="mt-1 text-3xl font-bold tracking-tight">Record</h1>
    </div>
    <div class="flex flex-wrap gap-2">
      <!-- Out of the day cards and up here: with every day on one scroll there
           is no "current" day for the form to belong to, so the day it writes
           became a field. -->
      <button
        class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift"
        data-add-session
        onclick={startAdding}
      >
        + Add a session
      </button>
      <button
        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={download}
      >
        Download CSVs
      </button>
    </div>
  </div>

  <!-- One group, because all three answer the same question: what a row on this
       page stands for. Grouping and merging were on opposite sides of the
       header while merging was the only one of them. -->
  <div class="mb-6 flex flex-wrap gap-1" role="group" aria-label="View">
    {#each [['project', 'By project'], ['tag', 'By tag']] as [value, label] (value)}
      <button
        class="meta rounded-md border px-4 py-2 transition
               {by === value
          ? 'border-ember bg-ember/10 text-paper'
          : 'border-white/15 hover:border-white/40'}"
        aria-pressed={by === value}
        data-group-by={value}
        onclick={() => (by = value)}
      >
        {label}
      </button>
    {/each}
    <!-- Not offered by tag, where a row is already a day of that tag and the
         toggle would be a control that is permanently, invisibly on. -->
    {#if by !== 'tag'}
      <button
        class="meta ml-2 rounded-md border px-4 py-2 transition
               {merged
          ? 'border-ember bg-ember/10 text-paper'
          : 'border-white/15 hover:border-white/40'}"
        aria-pressed={merged}
        onclick={() => (merged = !merged)}
      >
        Merge sessions
      </button>
    {/if}
  </div>

  {#if adding}
    <div class="mb-4 rounded-xl border border-white/10 bg-ink-soft px-5 py-4" data-adding>
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1.5">
          <span class="meta">Day</span>
          <input
            type="date"
            aria-label="Day"
            max={today()}
            bind:value={adding.day}
            class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
          />
        </div>
        <label class="flex flex-col gap-1.5">
          <span class="meta">Project</span>
          <select
            bind:value={adding.project_id}
            class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
          >
            {#each ($projectStore ?? []).filter((p) => p.active) as option (option.id)}
              <option value={option.id}>{option.name}</option>
            {/each}
          </select>
        </label>
        <div class="flex flex-col gap-1.5">
          <span class="meta">From</span>
          <TimeField label="From" bind:value={adding.startClock} />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="meta">To</span>
          <TimeField label="To" bind:value={adding.endClock} />
        </div>
        <button
          class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift
                 disabled:opacity-30"
          disabled={!adding.project_id || !adding.day || adding.day > today()}
          onclick={() => saveNew()}
        >
          Add session
        </button>
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
          onclick={() => (adding = null)}
        >
          Cancel
        </button>
      </div>
      {#if adding.day > today()}
        <!-- The record is what was tracked. A day that has not happened cannot
             have been, and the row would be written where nothing reads it. -->
        <p class="meta mt-3 normal-case text-ember">
          A session cannot be recorded on a day that has not happened yet.
        </p>
      {/if}
    </div>
  {/if}

  {#if clash}
    <!-- Asked rather than reported: an overlap on one project is either two
         halves of the same session or a slip, and both answers are one tap. -->
    <div
      data-overlap
      class="mb-4 rounded-xl border border-ember/50 bg-dusk/20 px-5 py-4"
    >
      <p class="font-medium">That overlaps another session on the same project.</p>
      <p class="mt-1 mb-3 text-sm text-haze">
        Merging keeps the earliest start and the latest end, and removes what it
        swallowed. One project cannot run twice over the same minutes — the hour
        would be counted twice under the same name.
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift"
          onclick={() => clash.retry()}
        >
          Merge into one
        </button>
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
          onclick={() => (clash = null)}
        >
          Discard the change
        </button>
      </div>
    </div>
  {/if}

  {#if loading}
    <p class="meta">Loading…</p>
  {:else if !hasProjects}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-6" data-no-projects>
      <h2 class="font-semibold">Nothing to record yet</h2>
      <p class="mt-1 mb-4 text-sm text-haze">
        A session is recorded against a project. Add one and its days appear here.
      </p>
      <a
        href="/time/projects"
        use:link
        class="meta inline-block rounded-md border border-white/15 px-4 py-2.5
               hover:border-white/40"
      >
        Manage projects →
      </a>
    </div>
  {:else}
    {#if merged}
      <p class="meta mb-3 normal-case">
        First start to last end. The duration counts tracked time only, so gaps
        between sessions do not add up.
      </p>
    {/if}
    {#if by === 'tag'}
      <!-- Stated rather than smoothed over, and in the same words the patterns
           page uses: a project under two tags genuinely counts in both, so a
           day here can total more than the hours it actually holds. -->
      <p class="meta mb-3 normal-case" data-across-tags>
        A day of each tag, after its rule. A project with several tags counts
        under each, so these totals overlap — they add to more than the hours
        actually tracked.
      </p>
    {/if}

    <div class="flex flex-col">
      {#each listing as week, index (week.start)}
        <div data-week={week.start} class="flex flex-col">
          <!-- Sticky so the week you are reading in is always named, however
               far down its days you have scrolled. Opaque `bg-ink`, or the
               rows would show through it. -->
          <div
            class="sticky top-0 z-10 flex items-baseline justify-between gap-3
                   bg-ink py-3"
          >
            <p class="meta">{week.heading}</p>
            <div class="flex items-baseline gap-4">
              {#if index === 0 && years.length > 1}
                <!-- On the newest week alone, and only where there is more than
                     one year to choose between: a way back to last autumn
                     without scrolling last autumn's way there. -->
                <label class="meta flex items-center gap-2">
                  <span class="hidden sm:inline">Go to</span>
                  <select
                    aria-label="Go to year"
                    data-go-to-year
                    bind:value={jumpTo}
                    onchange={() => goToYear(jumpTo)}
                    class="rounded-md border border-white/15 bg-ink px-2 py-1 text-xs
                           hover:border-white/40"
                  >
                    <option value="">Year</option>
                    {#each years as year (year)}
                      <option value={year}>{year}</option>
                    {/each}
                  </select>
                </label>
              {/if}
              <p
                class="numeral tabular-nums {week.seconds ? 'text-paper' : 'text-haze'}"
                data-week-total={week.start}
              >
                {formatDuration(week.seconds)}
              </p>
            </div>
          </div>

          <div class="flex flex-col gap-3 pb-3">
            {#each week.days as day (day)}
              <div data-day={day} class="rounded-xl border border-white/10 bg-ink-soft">
                <div class="flex items-center justify-between gap-3 px-5 py-3">
                  <p class="meta">
                    {day === today() ? 'Today' : dayLabel(day)}
                    <!-- Shown only when the day keeps a different clock from the
                         one you are in now: at home it would be noise, and after
                         a flight it is the difference between 09:00 and 09:00. -->
                    {#if dayClock(day) !== null}
                      <span class="ml-2 text-ember">{dayClock(day)}</span>
                    {/if}
                  </p>
                  <p class="numeral tabular-nums" data-day-total={day}>
                    {formatDuration(dayTotals.get(day) ?? 0)}
                  </p>
                </div>

                <ul class="flex flex-col gap-px border-t border-white/10">
                  {#each byDay.get(day) ?? [] as row (row.key)}
                    {@const shown = describe(row.group)}
                    {@const only = row.entries.length === 1 ? row.entries[0] : null}
                    <!-- A running row is the one thing on this page that is still
                         changing, so it is marked rather than left to be spotted by
                         reading every end time. -->
                    <li
                      class="px-5 py-3 {row.running
                        ? 'border-l-2 border-ember bg-dusk/15'
                        : ''}"
                      data-row={row.key}
                      data-sessions={row.entries.length}
                      data-live={row.running ? 'yes' : 'no'}
                    >
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-3">
                          <span
                            class="size-2.5 shrink-0 rounded-full"
                            style:background="var(--color-{shown.colour},
                              var(--color-dusk-lift))"
                          ></span>
                          <div class="min-w-0">
                            <p class="truncate font-medium">{shown.name}</p>
                            <!-- The clock reads this day's part of the session, not
                                 the whole of it: a row showing 22:15–01:55 beside
                                 1h 55m invites the wrong arithmetic. Each day shows
                                 its own part, and says where the rest of it went. -->
                            {#if row.daily}
                              <!-- A day of a tag has no single start and end,
                                   so the line carries what the rule took off
                                   instead — and nothing at all where no rule
                                   applies. -->
                              {#if row.deduction > 0}
                                <p class="meta mt-0.5 normal-case text-haze">
                                  after rule · −{formatDuration(row.deduction)}
                                </p>
                              {/if}
                            {:else}
                            <p class="meta mt-0.5 normal-case">
                              {clockOfSeconds(row.from)}
                              –
                              {row.running ? 'running' : clockOfSeconds(row.to)}
                              {#if row.whole}
                                <span class="text-haze">
                                  · kept whole, next day is on a different clock
                                </span>
                              {:else if row.crosses}
                                <span class="text-haze">
                                  · {row.from === 0 ? 'from earlier' : 'continues'}
                                </span>
                              {/if}
                              {#if !only}
                                <span class="text-haze">· {row.entries.length} sessions</span>
                              {/if}
                            </p>
                            {/if}
                          </div>
                        </div>
                        <div class="ml-auto flex shrink-0 items-center gap-2">
                          <span class="numeral tabular-nums">{formatDuration(row.seconds)}</span>
                          <!-- Merged and by-tag are reading views, not working
                               ones: a row there stands for several sessions, or
                               for one session counted under a second tag as
                               well. Offering to edit or delete "it" would be
                               offering what the row cannot honestly do. -->
                          {#if workable}
                            <button
                              class="meta rounded-md border border-white/15 px-3 py-2
                                     hover:border-white/40"
                              onclick={() => startEditing(only)}
                            >
                              Edit
                            </button>
                            <button
                              class="meta rounded-md border border-white/15 px-3 py-2
                                     hover:border-ember"
                              aria-label="Delete {shown.name} session"
                              onclick={() => remove(only)}
                            >
                              Delete
                            </button>
                          {/if}
                        </div>
                      </div>

                      {#if only && editing?.id === only.id}
                        <div
                          class="mt-3 flex flex-wrap items-end gap-3 border-t
                                 border-white/10 pt-3"
                        >
                          <label class="flex flex-col gap-1.5">
                            <span class="meta">Project</span>
                            <select
                              bind:value={editing.project_id}
                              class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                            >
                              {#each $projectStore ?? [] as option (option.id)}
                                <option value={option.id}>{option.name}</option>
                              {/each}
                            </select>
                          </label>
                          <div class="flex flex-col gap-1.5">
                            <span class="meta">Started</span>
                            <span class="flex gap-2">
                              <input
                                type="date"
                                aria-label="Started day"
                                bind:value={editing.startDay}
                                class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                              />
                              <TimeField label="Started time" bind:value={editing.startClock} />
                            </span>
                          </div>
                          {#if !editing.running}
                            <div class="flex flex-col gap-1.5">
                              <span class="meta">Ended</span>
                              <span class="flex gap-2">
                                <input
                                  type="date"
                                  aria-label="Ended day"
                                  bind:value={editing.endDay}
                                  class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                                />
                                <TimeField label="Ended time" bind:value={editing.endClock} />
                              </span>
                            </div>
                          {:else}
                            <p class="meta pb-2 normal-case">Still running — stop it on Track.</p>
                          {/if}
                          <button
                            class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold
                                   hover:bg-dusk-lift"
                            onclick={() => saveEdit()}
                          >
                            Save
                          </button>
                          <button
                            class="meta rounded-md border border-white/15 px-3 py-2
                                   hover:border-white/40"
                            onclick={() => (editing = null)}
                          >
                            Cancel
                          </button>
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/each}
          </div>
        </div>
      {/each}

      {#if atStart}
        <p class="meta py-6 text-center" data-history-end>Nothing tracked before this</p>
      {:else}
        <!-- Watched rather than clicked: reaching it loads four more weeks. -->
        <p class="meta py-6 text-center" data-more bind:this={sentinel}>
          Loading earlier weeks…
        </p>
      {/if}
    </div>
  {/if}
</section>
