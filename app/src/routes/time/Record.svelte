<script>
  import { attempt, unwrap } from '../../lib/api.js'
  import {
    createTimeEntry,
    deleteTimeEntry,
    exportTime,
    updateTimeEntry,
  } from '../../lib/generated/sdk.gen'
  import { dayLabel, shiftDay, today } from '../../lib/day.js'
  import { wide } from '../../lib/media.js'
  import { offsetLabel } from '../../lib/time/duration.js'
  import { resource } from '../../lib/resource.svelte.js'
  import {
    clockLabel,
    dayOffsets,
    clockOfSeconds,
    formatDuration,
    fromLocal,
    localDay,
    slices,
    utcOffset,
  } from '../../lib/time/duration.js'
  import TimeField from '../../lib/time/TimeField.svelte'
  import { now } from '../../lib/time/tick.js'
  import {
    ensureProjects,
    ensureTimeEntries,
    forgetEntry,
    projects as projectStore,
    rememberEntry,
    timeEntries,
  } from '../../lib/store.js'
  import { pushToast } from '../../lib/toasts.js'

  /**
   * Sessions by day, and the place they are corrected.
   *
   * A session crossing midnight is drawn on both days it touches, clipped to
   * each — the same division the totals use, so the reading and the arithmetic
   * agree. Editing always works on the whole session, never on a slice.
   */

  const DAYS_SHOWN = 7
  const SWIPE_THRESHOLD = 48

  /** Days loaded either side of what is shown, so stepping rarely refetches. */
  const PADDING = 3

  const DAY_SECONDS = 86_400

  let anchor = $state(today())
  let editing = $state(null)
  let adding = $state(null)
  let merged = $state(false)

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

  // A phone reads one day at a time, the way the wellbeing record does: seven
  // day-cards stacked is a page nobody scrolls to the bottom of, and the
  // buttons that widen a table are the buttons that turn a page here.
  const days = $derived(
    $wide
      ? Array.from({ length: DAYS_SHOWN }, (_, index) =>
          shiftDay(anchor, index - (DAYS_SHOWN - 1))
        )
      : [anchor]
  )

  /** Move by a page: a week on a wide screen, a day on a narrow one. */
  function step(delta) {
    anchor = shiftDay(anchor, $wide ? delta * DAYS_SHOWN : delta)
  }

  let touchStartX = 0

  function onTouchStart(event) {
    touchStartX = event.changedTouches[0].clientX
  }

  /** Treat a horizontal drag as a day change, the way a photo viewer would. */
  function onTouchEnd(event) {
    const travelled = event.changedTouches[0].clientX - touchStartX
    if (Math.abs(travelled) < SWIPE_THRESHOLD) return
    step(travelled < 0 ? 1 : -1)
  }

  /**
   * Every session's part of every day, as the rows a day lists.
   *
   * One row per session by default. Merged, one row per project per day: the
   * first start, the last end, and — deliberately — the time *tracked* rather
   * than the distance between them. A project worked 09:00–12:00 and 13:00–15:00
   * reads "09:00 – 15:00 · 5h 00m", because the hour at lunch was not worked.
   * The two numbers disagreeing is the point of merging, so the view says so
   * rather than leaving it to be discovered.
   */
  const byDay = $derived.by(() => {
    const map = new Map(days.map((day) => [day, []]))
    // One clock per day, taken from the session that opened it.
    const offsets = dayOffsets($timeEntries)
    for (const entry of $timeEntries) {
      const parts = slices(entry, $now, offsets)
      const crosses = parts.length > 1 || parts.some((part) => part.whole)
      for (const slice of parts) {
        if (map.has(slice.day)) {
          map.get(slice.day).push({ ...slice, entry, crosses })
        }
      }
    }

    for (const [day, list] of map) {
      const rows = merged ? mergeByProject(list) : list.map(asRow)
      map.set(day, rows.toSorted((a, b) => a.from - b.from))
    }
    return map
  })

  /** One session's slice, in the shape a row is drawn from. */
  function asRow(slice) {
    return {
      key: `${slice.entry.id}:${slice.from}`,
      project_id: slice.entry.project_id,
      from: slice.from,
      to: slice.to,
      seconds: slice.seconds,
      entries: [slice.entry],
      crosses: slice.crosses,
      whole: slice.whole ?? false,
      running: slice.entry.ended_at === null,
    }
  }

  /** Collapse a day's slices to one row per project. */
  function mergeByProject(list) {
    const byProject = new Map()
    for (const slice of list) {
      const found = byProject.get(slice.entry.project_id)
      if (!found) {
        byProject.set(slice.entry.project_id, {
          ...asRow(slice),
          key: `merged:${slice.entry.project_id}`,
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
    return [...byProject.values()]
  }

  const dayTotals = $derived(
    new Map(
      days.map((day) => [
        day,
        (byDay.get(day) ?? []).reduce((sum, row) => sum + row.seconds, 0),
      ])
    )
  )

  const loaded = resource(
    () => ({ start: shiftDay(days[0], -PADDING), end: shiftDay(days.at(-1), PADDING) }),
    (range) => Promise.all([ensureProjects(), ensureTimeEntries(range)]),
    { name: 'time record' }
  )

  const loading = $derived(loaded.loading && $timeEntries.length === 0)

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

  function startAdding(day) {
    editing = null
    adding = {
      day,
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
    // A merge removes the sessions it swallowed, and the store cannot know
    // which from the one row it gets back.
    if (merge) await ensureTimeEntries({ force: true })
    editing = null
    clash = null
  }

  async function saveNew(merge = false) {
    const offset = utcOffset()
    const created = await write(
      () =>
        createTimeEntry({
          body: {
            project_id: adding.project_id,
            started_at: fromLocal(adding.day, adding.startClock, offset),
            ended_at: fromLocal(adding.day, adding.endClock, offset),
            utc_offset: offset,
            merge_overlapping: merge,
          },
        }),
      () => saveNew(true)
    )
    if (!created) return
    rememberEntry(created)
    if (merge) await ensureTimeEntries({ force: true })
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
    editing = null
  }

  async function download() {
    // Everything, not the days on screen: the button reads "download", and on a
    // phone - which now shows a single day - a range would quietly export one.
    // The wellbeing export behaves the same way.
    const file = await attempt(() => exportTime({ parseAs: 'blob' }))
    if (!file) return
    const url = URL.createObjectURL(file)
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: 'tracked-time.xlsx',
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
  <div class="mb-8 flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="meta">Every session you have tracked</p>
      <h1 class="mt-1 text-3xl font-bold tracking-tight">Record</h1>
    </div>
    <div class="flex flex-wrap gap-2">
      <button
        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={() => step(-1)}
      >
        ← Earlier
      </button>
      <button
        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={() => step(1)}
      >
        Later →
      </button>
      <button
        class="meta rounded-md border px-3 py-2 transition
               {merged
          ? 'border-ember bg-ember/10 text-paper'
          : 'border-white/15 hover:border-white/40'}"
        aria-pressed={merged}
        onclick={() => (merged = !merged)}
      >
        Merge sessions
      </button>
      <button
        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={download}
      >
        Download .xlsx
      </button>
    </div>
  </div>

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
  {:else}
    {#if merged}
      <p class="meta mb-3 normal-case">
        First start to last end. The duration counts tracked time only, so gaps
        between sessions do not add up.
      </p>
    {/if}
    <div
      class="flex flex-col gap-3"
      ontouchstart={$wide ? undefined : onTouchStart}
      ontouchend={$wide ? undefined : onTouchEnd}
    >
      {#each [...days].reverse() as day (day)}
        {@const entries = byDay.get(day) ?? []}
        <div data-day={day} class="rounded-xl border border-white/10 bg-ink-soft">
          <div class="flex items-center justify-between gap-3 px-5 py-3">
            <p class="meta">
              {day === today() ? 'Today' : dayLabel(day)}
              <!-- Shown only when the day keeps a different clock from the one
                   you are in now: at home it would be noise, and after a flight
                   it is the difference between 09:00 and 09:00. -->
              {#if dayClock(day) !== null}
                <span class="ml-2 text-ember">{dayClock(day)}</span>
              {/if}
              {#if !$wide}<span class="ml-2 text-haze">swipe to change day</span>{/if}
            </p>
            <p class="numeral tabular-nums" data-day-total={day}>
              {formatDuration(dayTotals.get(day) ?? 0)}
            </p>
          </div>

          {#if entries.length}
            <ul class="flex flex-col gap-px border-t border-white/10">
              {#each entries as row (row.key)}
                {@const project = projects.get(row.project_id)}
                {@const only = row.entries.length === 1 ? row.entries[0] : null}
                <!-- A running row is the one thing on this page that is still
                     changing, so it is marked rather than left to be spotted by
                     reading every end time. -->
                <li
                  class="px-5 py-3 {row.running ? 'border-l-2 border-ember bg-dusk/15' : ''}"
                  data-row={row.key}
                  data-sessions={row.entries.length}
                  data-live={row.running ? 'yes' : 'no'}
                >
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-3">
                      <span
                        class="size-2.5 shrink-0 rounded-full"
                        style:background="var(--color-{project?.colour ??
                          'haze'}, var(--color-dusk-lift))"
                      ></span>
                      <div class="min-w-0">
                        <p class="truncate font-medium">{project?.name ?? 'Removed project'}</p>
                        <!-- The clock reads this day's part of the session, not
                             the whole of it: a row showing 22:15–01:55 beside
                             1h 55m invites the wrong arithmetic. Each day shows
                             its own part, and says where the rest of it went. -->
                        <p class="meta mt-0.5 normal-case">
                          {clockOfSeconds(row.from)}
                          –
                          {row.running ? 'running' : clockOfSeconds(row.to)}
                          {#if row.whole}
                            <span class="text-haze">· kept whole, next day is on a different clock</span>
                          {:else if row.crosses}
                            <span class="text-haze">
                              · {row.from === 0 ? 'from earlier' : 'continues'}
                            </span>
                          {/if}
                          {#if !only}
                            <span class="text-haze">· {row.entries.length} sessions</span>
                          {/if}
                        </p>
                      </div>
                    </div>
                    <div class="ml-auto flex shrink-0 items-center gap-2">
                      <span class="numeral tabular-nums">{formatDuration(row.seconds)}</span>
                      <!-- Merged is a reading, not a working, view: a row there
                           can stand for several sessions, and offering to edit
                           or delete "it" would be offering something the row
                           cannot honestly do. Turn merging off to work. -->
                      {#if !merged}
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
                          aria-label="Delete {project?.name ?? 'session'} session"
                          onclick={() => remove(only)}
                        >
                          Delete
                        </button>
                      {/if}
                    </div>
                  </div>

                  {#if only && editing?.id === only.id}
                    <div class="mt-3 flex flex-wrap items-end gap-3 border-t border-white/10 pt-3">
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
          {/if}

          <div class="border-t border-white/10 px-5 py-3">
            {#if adding?.day === day}
              <div class="flex flex-wrap items-end gap-3">
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
                  disabled={!adding.project_id}
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
            {:else}
              <button
                class="meta hover:text-paper"
                data-add-session={day}
                onclick={() => startAdding(day)}
              >
                + Add a session
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>
