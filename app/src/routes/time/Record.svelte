<script>
  import { attempt, unwrap } from '../../lib/api.js'
  import {
    checkIn,
    createTimeEntry,
    deleteTimeEntry,
    exportTime,
    updateTimeEntry,
  } from '../../lib/generated/sdk.gen'
  import { dayLabel, shiftDay, today } from '../../lib/day.js'
  import {
    clockLabel,
    clockOfSeconds,
    formatDuration,
    localDay,
    fromLocal,
    nowUtc,
    slices,
    utcOffset,
  } from '../../lib/time/duration.js'
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

  const DAY_SECONDS = 86_400

  let anchor = $state(today())
  let loading = $state(true)
  let editing = $state(null)
  let adding = $state(null)
  let merged = $state(false)

  const projects = $derived(new Map(($projectStore ?? []).map((p) => [p.id, p])))

  const days = $derived(
    Array.from({ length: DAYS_SHOWN }, (_, index) =>
      shiftDay(anchor, index - (DAYS_SHOWN - 1))
    )
  )

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
    for (const entry of $timeEntries) {
      const crosses = slices(entry, $now).length > 1
      for (const slice of slices(entry, $now)) {
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

  $effect(() => {
    load(days[0], days.at(-1))
  })

  async function load(start, end) {
    try {
      await Promise.all([ensureProjects(), ensureTimeEntries({ start, end })])
    } finally {
      loading = false
    }
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

  async function saveEdit() {
    const body = {
      project_id: editing.project_id,
      started_at: fromLocal(editing.startDay, editing.startClock, editing.offset),
    }
    if (!editing.running) {
      body.ended_at = fromLocal(editing.endDay, editing.endClock, editing.offset)
    }
    const saved = await attempt(() =>
      updateTimeEntry({ path: { entry_id: editing.id }, body })
    )
    if (!saved) return
    rememberEntry(saved)
    editing = null
  }

  async function saveNew() {
    const offset = utcOffset()
    const created = await attempt(() =>
      createTimeEntry({
        body: {
          project_id: adding.project_id,
          started_at: fromLocal(adding.day, adding.startClock, offset),
          ended_at: fromLocal(adding.day, adding.endClock, offset),
          utc_offset: offset,
        },
      })
    )
    if (!created) return
    rememberEntry(created)
    adding = null
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

  /** Start a fresh session on the same project: yesterday predicts today. */
  async function restart(entry) {
    const opened = await attempt(() =>
      checkIn({
        path: { project_id: entry.project_id },
        body: { at: nowUtc(), utc_offset: utcOffset() },
      })
    )
    if (!opened) return
    rememberEntry(opened)
    pushToast(`${projects.get(entry.project_id)?.name ?? 'Project'} running`, 'ok')
  }

  async function download() {
    const file = await attempt(() =>
      exportTime({ query: { start: days[0], end: days.at(-1) } })
    )
    if (!file) return
    const url = URL.createObjectURL(file)
    const anchorElement = Object.assign(document.createElement('a'), {
      href: url,
      download: 'tracked-time.xlsx',
    })
    anchorElement.click()
    URL.revokeObjectURL(url)
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
        onclick={() => (anchor = shiftDay(anchor, -DAYS_SHOWN))}
      >
        ← Earlier
      </button>
      <button
        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={() => (anchor = shiftDay(anchor, DAYS_SHOWN))}
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

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    {#if merged}
      <p class="meta mb-3 normal-case">
        First start to last end. The duration counts tracked time only, so gaps
        between sessions do not add up.
      </p>
    {/if}
    <div class="flex flex-col gap-3">
      {#each [...days].reverse() as day (day)}
        {@const entries = byDay.get(day) ?? []}
        <div data-day={day} class="rounded-xl border border-white/10 bg-ink-soft">
          <div class="flex items-center justify-between gap-3 px-5 py-3">
            <p class="meta">{dayLabel(day)}</p>
            <p class="numeral tabular-nums" data-day-total={day}>
              {formatDuration(dayTotals.get(day) ?? 0)}
            </p>
          </div>

          {#if entries.length}
            <ul class="flex flex-col gap-px border-t border-white/10">
              {#each entries as row (row.key)}
                {@const project = projects.get(row.project_id)}
                {@const only = row.entries.length === 1 ? row.entries[0] : null}
                <li class="px-5 py-3" data-row={row.key} data-sessions={row.entries.length}>
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
                          {#if row.crosses}
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
                      {#if only}
                        <button
                          class="meta rounded-md border border-white/15 px-3 py-2
                                 hover:border-white/40"
                          onclick={() => startEditing(only)}
                        >
                          Edit
                        </button>
                      {:else}
                        <!-- A merged row stands for several sessions, and there
                             is no honest single edit of it. Unmerging is one tap
                             away, and that is where the times can be corrected. -->
                        <button
                          class="meta rounded-md border border-white/15 px-3 py-2
                                 hover:border-white/40"
                          onclick={() => (merged = false)}
                        >
                          Split
                        </button>
                      {/if}
                      <button
                        class="meta rounded-md border border-white/15 px-3 py-2
                               hover:border-white/40"
                        aria-label="Restart {project?.name ?? 'project'}"
                        onclick={() => restart(row.entries[0])}
                      >
                        Restart
                      </button>
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
                          <input
                            type="time"
                            aria-label="Started time"
                            bind:value={editing.startClock}
                            class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                          />
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
                            <input
                              type="time"
                              aria-label="Ended time"
                              bind:value={editing.endClock}
                              class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                            />
                          </span>
                        </div>
                      {:else}
                        <p class="meta pb-2 normal-case">Still running — stop it on Track.</p>
                      {/if}
                      <button
                        class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold
                               hover:bg-dusk-lift"
                        onclick={saveEdit}
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
                      <button
                        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-ember"
                        onclick={() => remove(only)}
                      >
                        Delete
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
                <label class="flex flex-col gap-1.5">
                  <span class="meta">From</span>
                  <input
                    type="time"
                    bind:value={adding.startClock}
                    class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                  />
                </label>
                <label class="flex flex-col gap-1.5">
                  <span class="meta">To</span>
                  <input
                    type="time"
                    bind:value={adding.endClock}
                    class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                  />
                </label>
                <button
                  class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift
                         disabled:opacity-30"
                  disabled={!adding.project_id}
                  onclick={saveNew}
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
