<script>
  import { link } from '../lib/router.js'
  import { formatDuration, localDay } from '../lib/clock.js'
import { elapsed } from '../lib/time/duration.js'
  import { now } from '../lib/time/tick.js'
  import { dayTotals, pomodoroState, RUNNING } from '../lib/pomodoro/derive.js'
  import {
    answers as answerStore,
    catalogueDetails,
    ensureAnswers,
    ensureCatalogue,
    ensureMe,
    ensurePomodoros,
    ensureProjects,
    ensureTimeEntries,
    me as account,
    pomodoros as pomodoroStore,
    projects as projectStore,
    ready,
    timeEntries,
  } from '../lib/store.js'
  import { streak, today } from '../lib/day.js'

  /**
   * The one place the three halves meet.
   *
   * Not a menu: each card reports the state of its section before it is
   * touched, so the commonest actions of a day — answer today, stop a timer,
   * start a pomodoro — are one tap from where you land.
   *
   * Still the only bridge. None of the three links to another anywhere else,
   * which is what keeps "Record" and "Patterns" unambiguous inside each.
   */

  // What the disk has been asked for, and what the network has finished
  // answering. Both, because they end the ellipsis for different reasons: the
  // snapshot is what makes a bad connection paint at all, and a device that has
  // never reached this account has nothing to restore and must still stop
  // waiting once the attempt is over.
  let hydrated = $state(false)
  let settled = $state(false)

  const day = today()

  // True only while there is genuinely nothing to show. A restored snapshot
  // brings the account back with everything else it holds, so `me` standing in
  // for "the device knows this account" is what lets all three cards paint
  // before a single request has answered.
  const loading = $derived(!hydrated || (!$account && !settled))

  const questions = $derived(
    ($catalogueDetails[$account?.default_catalogue_id]?.questions ?? []).filter(
      (question) => question.active && question.origin === 'asked'
    )
  )

  const answeredToday = $derived(
    new Set(
      $answerStore
        .filter((row) => row.day === day)
        .map((row) => row.question_id)
    )
  )

  const outstanding = $derived(
    questions.filter((question) => !answeredToday.has(question.id)).length
  )

  // Over every answer the device holds, which this page already loads in full
  // for the count above — so the streak costs no second request and paints
  // from the snapshot with everything else.
  const streakDays = $derived(streak($answerStore.map((row) => row.day), day))

  const running = $derived(
    $timeEntries
      .filter((entry) => entry.ended_at === null)
      .map((entry) => ({
        entry,
        project: ($projectStore ?? []).find((p) => p.id === entry.project_id),
        seconds: elapsed(entry, $now),
      }))
      .filter((row) => row.project)
      .toSorted((a, b) => b.seconds - a.seconds)
  )

  const projectCount = $derived(($projectStore ?? []).filter((p) => p.active).length)

  const todaysPomodoros = $derived(
    ($pomodoroStore ?? []).filter(
      (row) => localDay(row.started_at, row.utc_offset) === day
    )
  )
  const focusing = $derived(
    todaysPomodoros.find((row) => pomodoroState(row, $now) === RUNNING)
  )
  const focusTotals = $derived(dayTotals(todaysPomodoros, $now))

  // No reactive dependency: this runs once, on mount, and assigns nothing the
  // markup below feeds back into. Everything it loads is read from the store.
  $effect(() => {
    void load()
  })

  /**
   * Restore what the device kept, then ask the server what has changed.
   *
   * The two are awaited separately and deliberately. Hydration is a disk read
   * that always finishes; the fetches behind it may not, and a card that waited
   * on them showed an ellipsis for the whole of a tunnel while the answer sat
   * in IndexedDB. Nothing below the first `await` is allowed to gate the paint.
   */
  async function load() {
    await ready()
    hydrated = true
    try {
      await Promise.all([
        // Chained rather than listed: which catalogue to read is the account's
        // to say, and it must not hold up the four loads that already know
        // what they are asking for.
        ensureMe().then((user) =>
          user?.default_catalogue_id ? ensureCatalogue(user.default_catalogue_id) : null
        ),
        ensureAnswers(),
        ensureProjects(),
        ensureTimeEntries({ start: day, end: day }),
        ensurePomodoros({ start: day, end: day }),
      ])
    } finally {
      settled = true
    }
  }
</script>

<section class="mx-auto w-full max-w-4xl px-5 py-10">
  <p class="meta">Today</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">What are you recording?</h1>

  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
    <!-- Wellbeing keeps the app's own accents; the time card previews the other
         half's, so the difference is visible before you go there. -->
    <a
      href="/answer"
      use:link
      data-card="wellbeing"
      class="flex min-h-52 flex-col justify-between rounded-xl border border-white/10
             bg-ink-soft p-6 transition hover:border-white/30 hover:bg-dusk/10"
    >
      <div>
        <!-- The streak rides on the section label rather than taking a line of
             its own: it is context for the card, not the thing the card is
             about, and a fourth line pushed the button off the fold on a
             phone. Hidden at zero, where it is only ever an accusation. -->
        <p class="meta flex items-baseline justify-between gap-3">
          <span>Wellbeing</span>
          {#if !loading && streakDays > 0}
            <span data-streak={streakDays}>
              Streak · {streakDays} {streakDays === 1 ? 'day' : 'days'}
            </span>
          {/if}
        </p>
        <p class="mt-3 text-2xl font-semibold">
          {#if loading}
            …
          {:else if questions.length === 0}
            No questions yet
          {:else if outstanding === 0}
            The day is recorded
          {:else}
            {outstanding} of {questions.length} left
          {/if}
        </p>
        <p class="mt-1 text-sm text-haze">
          {outstanding === 0 && questions.length > 0
            ? 'Every question answered for today.'
            : 'One tap per question.'}
        </p>
      </div>
      <span class="meta self-start rounded-md border border-white/20 px-4 py-2.5">
        {outstanding === 0 && questions.length > 0 ? 'Review today' : 'Answer today'} →
      </span>
    </a>

    <a
      href="/time"
      use:link
      data-card="time"
      class="section-time flex min-h-52 flex-col justify-between rounded-xl border
             border-white/10 bg-ink-soft p-6 transition hover:border-white/30
             hover:bg-dusk/10"
    >
      <div>
        <p class="meta">Time</p>
        {#if loading}
          <p class="mt-3 text-2xl font-semibold">…</p>
        {:else if running.length}
          <ul class="mt-3 flex flex-col gap-1.5">
            <!-- Keyed on the device's own identity: a timer started with no
                 connection has no row id yet, so two of them would key alike. -->
            {#each running as row (row.entry.client_id ?? row.entry.id)}
              <li class="flex items-baseline justify-between gap-3">
                <span class="flex min-w-0 items-center gap-2">
                  <span
                    class="size-2 shrink-0 rounded-full"
                    style:background="var(--color-{row.project.colour}, var(--color-dusk-lift))"
                  ></span>
                  <span class="truncate font-semibold">{row.project.name}</span>
                </span>
                <span class="numeral shrink-0 tabular-nums">{formatDuration(row.seconds)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-3 text-2xl font-semibold">
            {projectCount === 0 ? 'No projects yet' : 'Nothing running'}
          </p>
          <p class="mt-1 text-sm text-haze">
            {projectCount === 0
              ? 'Name a project and it becomes a button.'
              : 'Tap a project to start its timer.'}
          </p>
        {/if}
      </div>
      <span class="meta self-start rounded-md border border-white/20 px-4 py-2.5">
        {running.length ? 'Check out' : 'Check in'} →
      </span>
    </a>

    <a
      href="/focus"
      use:link
      data-card="focus"
      class="section-focus flex min-h-52 flex-col justify-between rounded-xl border
             border-white/10 bg-ink-soft p-6 transition hover:border-white/30
             hover:bg-dusk/10"
    >
      <div>
        <p class="meta">Focus</p>
        {#if loading}
          <p class="mt-3 text-2xl font-semibold">…</p>
        {:else if focusing}
          <p class="mt-3 truncate text-2xl font-semibold">
            {focusing.task ?? 'Focusing'}
          </p>
          <p class="mt-1 text-sm text-haze">A pomodoro is running.</p>
        {:else if focusTotals.count > 0}
          <p class="mt-3 text-2xl font-semibold">
            {focusTotals.count}
            {focusTotals.count === 1 ? 'pomodoro' : 'pomodoros'}
          </p>
          <p class="mt-1 text-sm text-haze">
            {formatDuration(focusTotals.focus)} of focus today.
          </p>
        {:else}
          <p class="mt-3 text-2xl font-semibold">Nothing yet</p>
          <p class="mt-1 text-sm text-haze">One press and the clock runs.</p>
        {/if}
      </div>
      <span class="meta self-start rounded-md border border-white/20 px-4 py-2.5">
        {focusing ? 'Back to it' : 'Start a pomodoro'} →
      </span>
    </a>
  </div>
</section>
