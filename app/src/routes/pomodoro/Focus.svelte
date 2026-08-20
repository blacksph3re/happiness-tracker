<script>
  import { today } from '../../lib/day.js'
  import {
    clockLabel,
    formatDuration,
    fromLocal,
    localDay,
    nowUtc,
    plusSeconds,
  } from '../../lib/clock.js'
  import TimeField from '../../lib/time/TimeField.svelte'
  import StatusMark from '../../lib/pomodoro/StatusMark.svelte'
  import { now } from '../../lib/time/tick.js'
  import { lengthsFor } from '../../lib/pomodoro/mode.js'
  import { link } from '../../lib/router.js'
  import {
    COMPLETE,
    RUNNING,
    liveSplit,
    dayTotals,
    plannedEnd,
    pomodoroState,
    progress,
    splitSeconds,
  } from '../../lib/pomodoro/derive.js'
  import {
    playAmbience,
    playChime,
    stopAmbience,
    unlockAudio,
  } from '../../lib/pomodoro/sounds.js'
  import {
    ensurePomodoros,
    ensurePreferences,
    preferenceSection,
    preferences,
    pomodoros as pomodoroStore,
    removePomodoro,
    savePomodoro,
    savePomodoros,
  } from '../../lib/store.js'
  import IconBin from '../../lib/IconBin.svelte'
  import IconPencil from '../../lib/IconPencil.svelte'
  import Transfer from './Transfer.svelte'

  /**
   * The timer, and the day it has produced so far.
   *
   * Two things here are worth knowing before reading the rest. The elapsed time
   * is never counted — it is derived from `started_at` on every tick, so a tab
   * that slept through the focus paints the right width when it wakes instead
   * of resuming a count that stopped. And a pomodoro left alone needs nothing
   * written to finish: `ended_at` is sent only when Abandon is pressed, or when
   * starting the next one cuts a break short.
   */

  const day = today()

  let task = $state('')
  /** Which phase the last chime was for, so one boundary rings exactly once. */
  let chimed = $state(null)

  const settings = $derived(preferenceSection($preferences, 'focus'))
  const mode = $derived(lengthsFor(settings))

  // Read from the store rather than snapshotted out of the loader: a pomodoro
  // started on another device has to be able to arrive.
  const todays = $derived(
    ($pomodoroStore ?? [])
      .filter((row) => localDay(row.started_at, row.utc_offset) === day)
      .toSorted((a, b) => a.started_at.localeCompare(b.started_at))
  )

  const running = $derived(todays.find((row) => pomodoroState(row, $now) === RUNNING))
  /**
   * The day's list, newest first, **including** one still running.
   *
   * It is part of the day the moment it starts: leaving it out meant the totals
   * jumped by half an hour when a block ended rather than climbing while it ran.
   * The row carries no edit or delete control until it is over — correcting
   * something whose end is still moving is a fight with the clock — and its
   * mark is a ring rather than a verdict.
   */
  const listed = $derived(todays.toReversed())
  const totals = $derived(dayTotals(todays, beat))
  const bar = $derived(running ? progress(running, beat) : null)

  /**
   * The clock this page reads, aligned to the pomodoro's own start.
   *
   * The shared `now` store ticks on a one-second interval that began whenever
   * something first subscribed to it, which has nothing to do with when Start
   * was pressed. Press it 900ms into that interval and the countdown sits on
   * 25:00 for nearly two seconds before moving — which is the first second
   * feeling long. Scheduled against `started_at` instead, so the first change
   * lands exactly one second after the tap.
   */
  let beat = $state(Date.now())

  /**
   * When the running pomodoro began, or null.
   *
   * The effect below depends on this and nothing else. It must **not** depend
   * on anything derived from `beat`, or it would be an effect re-triggered by
   * its own write — the loop this codebase has a `resource()` helper to
   * prevent, and which fails silently rather than throwing when the write
   * lands after an await.
   */
  const runningStart = $derived(running?.started_at ?? null)

  $effect(() => {
    // Nothing running: the shared tick is all the finished list needs.
    if (!runningStart) {
      beat = $now
      return
    }
    const startedAt = Date.parse(`${runningStart}Z`)
    let handle
    const schedule = () => {
      const wait = 1000 - ((Date.now() - startedAt) % 1000)
      handle = setTimeout(() => {
        beat = Date.now()
        schedule()
      }, wait)
    }
    beat = Date.now()
    schedule()
    return () => clearTimeout(handle)
  })

  $effect(() => {
    ensurePomodoros({ start: day, end: day })
    ensurePreferences()
  })

  // The focus sound follows the phase rather than the pomodoro: it belongs to
  // concentrating, so it stops for the break and comes back with the next one.
  $effect(() => {
    if (bar?.phase === 'focus') playAmbience(settings.ambience ?? 'none')
    else stopAmbience()
    return stopAmbience
  })

  /**
   * Which phase the page is showing, including after the pomodoro has ended.
   *
   * `running` goes undefined the moment a pomodoro finishes, so reading the
   * phase off `bar` alone never sees the end — which is why the chime at the
   * end of the last break never played. `done` is a phase like any other here.
   */
  const phase = $derived(bar ? bar.phase : todays.length ? 'done' : 'idle')

  // One chime, when the **focus** ends — not when the break does. A break
  // running out needs no announcement: either you are back and can see it, or
  // you are not and the next thing you do is start another one.
  //
  // Keyed on the phase rather than on a timer, because a tab that was asleep at
  // the boundary arrives already past it, and ringing then is the honest thing:
  // the alert is late, not absent. Leaving `focus` covers both endings — into a
  // break, or straight to done when the break is zero.
  $effect(() => {
    const now = phase
    if (now === chimed) return
    if (chimed === 'focus') playChime(settings.chime ?? 'none')
    chimed = now
  })

  async function start() {
    // While the tap is still on the stack. See `unlockAudio`.
    unlockAudio()
    const next = {
      task: task.trim() || null,
      started_at: nowUtc(),
      utc_offset: -new Date().getTimezoneOffset(),
      focus_seconds: mode.focus,
      break_seconds: mode.rest,
      tainted: false,
    }
    // Starting during a break ends the one before it. That is the only way a
    // break is ever cut short — there is no button for it — and the part that
    // was used still counts as time spent.
    //
    // Both in one queue entry, not two calls: the flush the first would start
    // is still in flight when the second is appended, and that drain already
    // read the queue. The second would wait for the next wake.
    await savePomodoros(
      running ? [{ ...running, ended_at: nowUtc() }, next] : [next]
    )
    task = ''
    chimed = 'focus'
  }

  /** End the focus now. What has elapsed is kept; no break is added. */
  async function abandon() {
    if (running) await savePomodoro({ ...running, ended_at: nowUtc() })
  }

  async function toggleTaint(pomodoro) {
    await savePomodoro({ ...pomodoro, tainted: !pomodoro.tainted })
  }

  /**
   * The pomodoro being corrected, unpacked into fields.
   *
   * The same three the time module lets a session be corrected by, read the
   * same way: local day and clock rather than the stored UTC instant, because
   * what you are fixing is when it happened where you were.
   *
   * Duration is the elapsed time, not the phase lengths. Those are the mode
   * that was in force and are not retroactive — change them in Settings and
   * tomorrow's pomodoros follow, which is the point of storing them per row.
   */
  let editing = $state(null)

  function startEditing(pomodoro) {
    confirming = null
    editing = {
      client_id: pomodoro.client_id,
      task: pomodoro.task ?? '',
      startDay: localDay(pomodoro.started_at, pomodoro.utc_offset),
      startClock: clockLabel(pomodoro.started_at, pomodoro.utc_offset),
      minutes: Math.round(elapsedOf(pomodoro) / 60),
      planned: (pomodoro.focus_seconds + pomodoro.break_seconds) / 60,
      source: pomodoro,
    }
  }

  /** A finished pomodoro's elapsed seconds, however it finished. */
  function elapsedOf(pomodoro) {
    const split = splitSeconds(pomodoro)
    return split.focus + split.rest
  }

  async function saveEdit() {
    const { source } = editing
    const started_at = fromLocal(editing.startDay, editing.startClock, source.utc_offset)
    const planned = source.focus_seconds + source.break_seconds
    const seconds = Math.max(
      60,
      Math.min(planned, Math.round(Number(editing.minutes) || 0) * 60)
    )
    await savePomodoro({
      ...source,
      task: editing.task.trim() || null,
      started_at,
      // The full length is stored as *no* end, not as an end at the planned
      // moment: that is what "nothing stopped it" means here, and writing one
      // would turn every corrected pomodoro into a stopped one.
      ended_at: seconds >= planned ? null : plusSeconds(started_at, seconds),
    })
    editing = null
  }

  /**
   * Which pomodoro is being asked about before it is deleted.
   *
   * In the row rather than in a browser dialog, as Resume asks on the project
   * card: a modal takes the list away at the moment you want to check you are
   * deleting the right line of it.
   */
  let confirming = $state(null)

  async function discard(pomodoro) {
    confirming = null
    await removePomodoro(pomodoro.client_id)
  }

  /** How a finished pomodoro reads in the list. */
  function stateLabel(pomodoro) {
    return pomodoroState(pomodoro, $now) === COMPLETE ? 'Complete' : 'Abandoned'
  }
</script>

<section class="mx-auto w-full max-w-3xl px-5 py-10">
  <p class="meta">Focus</p>
  <h1 class="mt-1 text-3xl font-bold tracking-tight">
    {#if running}
      {bar.phase === 'break' ? 'Break' : 'Focusing'}
    {:else}
      Ready
    {/if}
  </h1>

  {#if running}
    <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-running>
      <div class="flex items-baseline justify-between gap-4">
        <!-- Not the heading font when there is nothing to head: "Unnamed" set
             in semibold read as a task actually called that. -->
        {#if running.task}
          <p class="min-w-0 truncate text-lg font-semibold">{running.task}</p>
        {:else}
          <p class="meta min-w-0 truncate normal-case text-haze" data-no-task>
            no task description
          </p>
        {/if}
        <p class="numeral shrink-0 text-2xl tabular-nums" data-remaining>
          {Math.floor(bar.remaining / 60)}:{String(bar.remaining % 60).padStart(2, '0')}
        </p>
      </div>

      <!-- Width comes from the timestamps, not from an animation: a bar driven
           by a transition would be wrong for as long as it took to catch up. -->
      <div class="mt-4 h-3 overflow-hidden rounded-full bg-white/10">
        <div
          data-progress
          class="h-full rounded-full transition-[width] duration-1000 ease-linear
                 {bar.phase === 'break' ? 'bg-sage' : 'bg-dusk-lift'}"
          style:width="{Math.min(100, bar.fraction * 100)}%"
        ></div>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <p class="meta">
          {bar.phase === 'break' ? 'Break' : 'Focus'} ·
          {clockLabel(running.started_at, running.utc_offset)} start
        </p>
        <!-- Only during the focus. A break has no abort button on purpose: the
             one way out of it is starting the next pomodoro, which is the card
             below. A second control here would be a second way to mean the
             same thing, with different arithmetic behind it. -->
        {#if bar.phase === 'focus'}
          <button
            data-abandon
            class="meta rounded-md border border-white/20 px-4 py-2 transition
                   hover:border-alarm"
            onclick={abandon}
          >
            Abandon
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if !running || bar.phase === 'break'}
    <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6">
      <!-- One button with something you may fill in first, not a form you have
           to get through: both fields are optional, so the timer must start
           from a single press. -->
      <label class="meta" for="focus-task">
        {running ? 'Next, when you are ready' : 'What are you focusing on?'}
      </label>
      <input
        id="focus-task"
        bind:value={task}
        placeholder="Optional"
        class="mt-2 w-full rounded-md border border-white/15 bg-ink px-3 py-2.5
               text-paper placeholder:text-haze/60"
        onkeydown={(event) => event.key === 'Enter' && start()}
      />
      <div class="mt-4 flex items-center justify-between gap-3">
        <!-- Nothing on this page changes the lengths or the sounds, and without
             this there was nothing saying where they live. -->
        <a href="/settings" use:link class="meta hover:text-paper">
          {mode.label} · settings →
        </a>
        <button
          data-start
          class="rounded-md bg-dusk px-6 py-2.5 font-semibold transition hover:bg-dusk-lift"
          onclick={start}
        >
          {running ? 'Start the next one' : 'Start'}
        </button>
      </div>
    </div>
  {/if}

  <div class="mt-8 flex flex-wrap items-baseline gap-x-6 gap-y-1" data-totals>
    <p>
      <span class="meta">Pomodoros</span>
      <span class="numeral" data-count>{totals.count}</span>
    </p>
    <p><span class="meta">Focus</span> <span class="numeral">{formatDuration(totals.focus)}</span></p>
    <p><span class="meta">Break</span> <span class="numeral">{formatDuration(totals.rest)}</span></p>
    {#if totals.tainted > 0}
      <p><span class="meta">Tainted</span> <span class="numeral">{formatDuration(totals.tainted)}</span></p>
    {/if}
  </div>

  <Transfer {day} seconds={totals.focus + totals.rest - totals.pending} pending={totals.pending} />

  {#if listed.length}
    <ul class="mt-8 flex flex-col gap-2">
      {#each listed as pomodoro (pomodoro.client_id ?? pomodoro.id)}
        {@const live = pomodoroState(pomodoro, beat) === RUNNING}
        {@const split = live ? liveSplit(pomodoro, beat) : splitSeconds(pomodoro)}
        {@const id = pomodoro.client_id ?? pomodoro.id}
        <li
          data-pomodoro
          class="rounded-lg border border-white/10 bg-ink-soft px-3 py-2.5 sm:px-4 sm:py-3"
        >
          <!-- A grid, not two flex rows: the break line underneath has to put
               its duration in the same column as the focus above it, and only
               shared tracks make two rows line up. Its duration sat under the
               buttons before, which read as belonging to them. -->
          <div
            class="grid grid-cols-[auto_auto_1fr_auto_auto] items-center gap-x-2
                   gap-y-1 sm:gap-x-3"
          >
            <StatusMark
              state={pomodoroState(pomodoro, beat)}
              tainted={pomodoro.tainted}
              onclick={() => toggleTaint(pomodoro)}
            />
            <span class="numeral shrink-0 text-sm text-haze">
              {clockLabel(pomodoro.started_at, pomodoro.utc_offset)}
            </span>
            <!-- An unnamed pomodoro is an unlabelled gap rather than a
                 placeholder: the time and the mark already say what it was. -->
            <span class="min-w-0 flex-1 truncate text-sm">{pomodoro.task ?? ''}</span>
            <span class="numeral shrink-0 text-sm tabular-nums">
              {formatDuration(split.focus)}
            </span>

            <span class="flex items-center gap-2 justify-self-end">
            {#if live}
              <!-- No controls until it is over: an end time that is still
                   moving is not something to correct. -->
              <span class="meta text-haze">running</span>
            {:else if confirming === id}
              <!-- In place of the row's controls, not beside them: the question
                   and the buttons answering it should not sit next to the
                   buttons that raised it. -->
              <!-- Hidden on a phone, where the row has no width to spare and
                   two buttons named Delete and Cancel are their own question. -->
              <span class="meta hidden shrink-0 normal-case sm:inline">Delete it?</span>
              <button
                data-delete-confirm
                class="meta shrink-0 rounded border border-alarm px-2 py-1 text-paper
                       transition hover:bg-alarm/10"
                onclick={() => discard(pomodoro)}
              >
                Delete
              </button>
              <button
                class="meta shrink-0 rounded border border-white/20 px-2 py-1 transition
                       hover:border-white/40"
                onclick={() => (confirming = null)}
              >
                Cancel
              </button>
            {:else}
              <button
                class="shrink-0 rounded border border-white/15 p-1.5 transition
                       hover:border-white/40"
                aria-label="Edit pomodoro"
                onclick={() => (editing?.client_id === id ? (editing = null) : startEditing(pomodoro))}
              >
                <IconPencil />
              </button>
              <!-- Opens the question rather than doing anything, so it hovers
                   white like every other outlined control; the ember belongs on
                   the button that actually deletes. -->
              <button
                class="shrink-0 rounded border border-white/15 p-1.5 transition
                       hover:border-white/40"
                aria-label="Delete pomodoro"
                onclick={() => (confirming = id)}
              >
                <IconBin />
              </button>
            {/if}
            </span>

            {#if split.rest > 0}
              <!-- The break that followed, under the focus it belongs to and
                   in the same columns. It is worked time like any other and it
                   is what the gap between two rows actually was, so leaving it
                   to be inferred from the clock was the list withholding
                   something it knew. -->
              <span data-break class="contents">
                <span></span>
                <span class="numeral text-xs text-haze">
                  {clockLabel(
                    plusSeconds(pomodoro.started_at, split.focus),
                    pomodoro.utc_offset
                  )}
                </span>
                <span class="meta min-w-0 normal-case text-haze">break</span>
                <span class="numeral text-xs tabular-nums text-haze">
                  {formatDuration(split.rest)}
                </span>
                <span></span>
              </span>
            {/if}
          </div>

          {#if editing?.client_id === id}
            <div
              data-editing
              class="mt-3 flex flex-wrap items-end gap-3 border-t border-white/10 pt-3"
            >
              <label class="flex min-w-40 flex-1 flex-col gap-1.5">
                <span class="meta">Task</span>
                <input
                  bind:value={editing.task}
                  placeholder="Optional"
                  class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm
                         placeholder:text-haze/60"
                />
              </label>
              <div class="flex flex-col gap-1.5">
                <span class="meta">Started</span>
                <span class="flex flex-wrap gap-2">
                  <input
                    type="date"
                    aria-label="Started day"
                    bind:value={editing.startDay}
                    class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                  />
                  <TimeField label="Started time" bind:value={editing.startClock} />
                </span>
              </div>
              <label class="flex flex-col gap-1.5">
                <span class="meta">Ran for, minutes</span>
                <input
                  type="number"
                  min="1"
                  max={editing.planned}
                  step="1"
                  bind:value={editing.minutes}
                  class="numeral w-28 rounded-lg border border-white/15 bg-ink px-3 py-2
                         text-sm"
                />
              </label>
              <button
                data-save-edit
                class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift"
                onclick={saveEdit}
              >
                Save
              </button>
              <button
                class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
                onclick={() => (editing = null)}
              >
                Cancel
              </button>
              <p class="meta w-full normal-case text-haze">
                {editing.planned} minutes was the mode at the time. Change the mode in
                Settings; it does not rewrite what is already recorded.
              </p>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if !running}
    <p class="mt-8 text-haze">Nothing yet today.</p>
  {/if}
</section>
