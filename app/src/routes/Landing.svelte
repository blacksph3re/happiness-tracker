<script>
  import Frame from '../lib/Frame.svelte'
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
    archiveList,
    ensureTimeEntries,
    ensureTodos,
    me as account,
    pomodoros as pomodoroStore,
    projects as projectStore,
    ready,
    timeEntries,
    todos as todoStore,
  } from '../lib/store.js'
  import { today } from '../lib/day.js'
  import { isOverdue } from '../lib/todos/fields.js'
  import {
    bestRun,
    habitStreak,
    habitsIn,
    periodKey,
    runLabel,
    tally,
  } from '../lib/habits.js'

  /**
   * The one place the four halves meet.
   *
   * Not a menu: each card reports the state of its section before it is
   * touched, so the commonest actions of a day — answer today, stop a timer,
   * start a pomodoro, see what is overdue — are one tap from where you land.
   *
   * Still the only bridge. None of the four links to another anywhere else,
   * which is what keeps "Record" and "Patterns" unambiguous inside each — and
   * the todo half does not link to Focus even though a task can start a
   * pomodoro.
   */

  // What the disk has been asked for, and what the network has finished
  // answering. Both, because they end the ellipsis for different reasons: the
  // snapshot is what makes a bad connection paint at all, and a device that has
  // never reached this account has nothing to restore and must still stop
  // waiting once the attempt is over.
  let hydrated = $state(false)
  let settled = $state(false)

  const day = today()

  /**
   * The look of every card action, named once because there are eight of them.
   *
   * Centred rather than `self-start`: the pair is a two-column grid, so each
   * button already fills its half and a left-aligned label would leave the
   * two looking different widths when the words differ in length.
   *
   * No border utility beside the kind: `border-white/20` sat here, and a
   * utility outranks the kind's own hover, so none of the eight buttons ever
   * answered a pointer.
   */
  const ACTION = 'btn-outline meta flex text-center transition'

  /**
   * The cards' grid, named once because the habits below line up under it.
   *
   * Four across at the widest rather than three: a fourth card on a three-
   * column row leaves one alone on a line of its own. Two at `sm` is what keeps
   * a phone one column and a tablet two.
   */
  const CARDS = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4'

  // True only while there is genuinely nothing to show. A restored snapshot
  // brings the account back with everything else it holds, so `me` standing in
  // for "the device knows this account" is what lets every card paint before a
  // single request has answered.
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

  // Over every answer the device holds and the catalogue it already loads for
  // the count above, so every streak costs no second request and paints from
  // the snapshot with everything else — including with no connection at all.
  const habits = $derived(
    habitsIn($catalogueDetails[$account?.default_catalogue_id]).map((habit) => {
      const tallies = tally(habit, $answerStore, questions.length)
      return {
        habit,
        run: habitStreak(habit, tallies, day),
        best: bestRun(habit, tallies, day),
        // What the period on the clock stands at, for a habit with no run to
        // show. Zero is only an accusation on a card nobody opened on purpose;
        // in a list somebody came to see, it owes an explanation.
        standing: tallies[periodKeyFor(habit)]?.count ?? 0,
      }
    })
  )

  function periodKeyFor(habit) {
    return periodKey(habit.period, day)
  }

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

  /**
   * The tasks that are still somebody's to do.
   *
   * `GET /api/todos` already leaves the archive out, so the list id is only
   * needed for a row *this* device archived a moment ago and has not re-read.
   * Read from the store's own `archiveList` rather than loaded: the counts
   * below are not worth a second request on the page a cold start paints
   * first, and a landing page that waited on one would be the ellipsis this
   * file exists to remove.
   */
  const open = $derived(
    ($todoStore ?? []).filter(
      (row) => !row.done_at && row.list_id !== ($archiveList?.id ?? null)
    )
  )

  /**
   * What the todo card reports, in the order it is worth saying.
   *
   * Overdue first because it is the number that changes what you do next; then
   * what is due today, which is a deadline rather than a plan; then what was
   * planned for today, which is the ordinary case; and last what is planned for
   * a day that has gone, so "Nothing planned" is only said when it is true. One
   * line and never three: a card is a reading, not a report.
   *
   * *Overdue* is `isOverdue`, the function the card's red due chip reads — a
   * **due** day before today, on a task that is not done. It used to be a
   * *planned* day before today, spelled here and on the card separately; a
   * plan for a day that has gone is past rather than late, and one function is
   * what stops the two readings of the word drifting apart again.
   */
  const todoCount = $derived.by(() => {
    const overdue = open.filter((row) => isOverdue(row, day)).length
    if (overdue) return { n: overdue, what: 'overdue' }
    const due = open.filter((row) => row.due_on === day).length
    if (due) return { n: due, what: 'due today' }
    const planned = open.filter((row) => row.planned_on === day).length
    if (planned) return { n: planned, what: 'planned today' }
    return { n: open.filter((row) => row.planned_on < day).length, what: 'in the past' }
  })

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
        ensureTodos(),
      ])
    } finally {
      settled = true
    }
  }
</script>

<!-- `max-w-6xl`, not the `4xl` three cards had: four columns inside 56rem draw
     each card narrower than any card here has ever been, and a card's width is
     what decides whether "Check out" and "Patterns" sit side by side. 72rem
     over four is within a hair of 56rem over three, so nothing but the count
     changed. -->
<Frame column="max-w-6xl">
<section class="max-w-6xl">
  <p class="meta">Today</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">What are you recording?</h1>

  <div class={CARDS}>
    <!-- Each card is a section rather than a link now: it carries two of them,
         and an anchor inside an anchor is not something HTML has an answer for.
         The pair is a two-column grid with stretched items, which is what makes
         the buttons one size — equal padding does not, because an arrow glyph
         and a word do not share a line box. `e2e/mobile.spec.js` measures it. -->

    <!-- Wellbeing keeps the app's own accents; the time card previews the other
         half's, so the difference is visible before you go there. -->
    <section
      data-card="wellbeing"
      class="flex min-h-52 flex-col justify-between rounded-xl border border-white/10
             bg-ink-soft p-6"
    >
      <div>
        <!-- The streak used to ride on this label. It is in the habits strip
             below now, as one habit among the others: the same number in two
             places is the failure the transfer button already taught this
             codebase, and a fourth line here pushed the button off the fold on
             a phone. -->
        <p class="meta">Wellbeing</p>
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
      </div>
      <div class="mt-4 grid grid-cols-2 items-stretch gap-2">
        <a href="/answer" use:link data-go="record" class={ACTION}>
          {outstanding === 0 && questions.length > 0 ? 'Review' : 'Answer'}
        </a>
        <a href="/stats" use:link data-go="patterns" class={ACTION}>Patterns</a>
      </div>
    </section>

    <section
      data-card="time"
      class="section-time flex min-h-52 flex-col justify-between rounded-xl border
             border-white/10 bg-ink-soft p-6"
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
        {/if}
      </div>
      <div class="mt-4 grid grid-cols-2 items-stretch gap-2">
        <a href="/time" use:link data-go="record" class={ACTION}>
          {running.length ? 'Check out' : 'Check in'}
        </a>
        <a href="/time/patterns" use:link data-go="patterns" class={ACTION}>Patterns</a>
      </div>
    </section>

    <section
      data-card="focus"
      class="section-focus flex min-h-52 flex-col justify-between rounded-xl border
             border-white/10 bg-ink-soft p-6"
    >
      <div>
        <p class="meta">Focus</p>
        {#if loading}
          <p class="mt-3 text-2xl font-semibold">…</p>
        {:else if focusing}
          <p class="mt-3 truncate text-2xl font-semibold">
            {focusing.task ?? 'Focusing'}
          </p>
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
        {/if}
      </div>
      <div class="mt-4 grid grid-cols-2 items-stretch gap-2">
        <a href="/focus" use:link data-go="record" class={ACTION}>
          {focusing ? 'Back to it' : 'Start'}
        </a>
        <a href="/focus/patterns" use:link data-go="patterns" class={ACTION}>Patterns</a>
      </div>
    </section>

    <section
      data-card="todos"
      class="section-todo flex min-h-52 flex-col justify-between rounded-xl border
             border-white/10 bg-ink-soft p-6"
    >
      <div>
        <p class="meta">Todos</p>
        <!-- The count is over every list; Tasks opens on the ones the board
             remembers. So it is labelled rather than narrowed — the house rule
             about `67h 35m across tags`: the useful number, with what it counts
             said beside it. "4 overdue" over a board showing three of them,
             with nothing saying where the fourth was, is the reading this
             removes. -->
        <p class="mt-3 text-2xl font-semibold" data-todo-reading>
          {#if loading}
            …
          {:else if todoCount.n === 0}
            Nothing planned
          {:else}
            {todoCount.n} {todoCount.what}
            <!-- One phrase: at four cards across it split and left "lists"
                 alone on a line. It may take a line of its own; its words
                 stay together. -->
            <span class="text-sm font-normal whitespace-nowrap text-haze">across your lists</span>
          {/if}
        </p>
      </div>
      <!-- Calendar rather than Patterns, and it is not a renaming: this half
           has no patterns page. The week is the second way of looking at the
           same tasks, which is what the second action on every other card is
           for. The attribute keeps the name the other three use, so the
           six-link test became an eight-link one rather than eight and a
           special case. -->
      <div class="mt-4 grid grid-cols-2 items-stretch gap-2">
        <a href="/todos" use:link data-go="record" class={ACTION}>Tasks</a>
        <a href="/todos/calendar" use:link data-go="patterns" class={ACTION}>Calendar</a>
      </div>
    </section>
  </div>

  <!-- Below the cards rather than inside one. Every chip is a link to the
       questionnaire, because a habit is an ordinary question and that is where
       it is answered — there is deliberately no tick here, which would be a
       second place to answer and could not offer a three-way choice anyway. -->
  {#if !loading && habits.length > 0}
    <section class="mt-10" data-habits>
      <p class="meta mb-3">Habits</p>
      <!-- The same grid as the cards above, so a habit lines up under a section
           rather than sitting in a row of its own width. Literally the same
           string: the cards gained a fourth column for the todo card, and a
           habit row left on the old one would line up with nothing. -->
      <div class={CARDS}>
        {#each habits as { habit, run, best, standing } (habit.key)}
          <!-- Straight to the streak view, not to the questionnaire. A habit
               chip is a reading, and the thing a reading invites is a longer
               look at it — answering is what the Wellbeing card is for. -->
          <a
            href="/stats?view=streaks"
            use:link
            data-habit={habit.key}
            data-run={run}
            class="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-ink-soft
                   p-6 transition hover:border-white/30 hover:bg-dusk/10"
          >
            <span class="flex items-center gap-2">
              {#if habit.icon}
                <span class="text-xl leading-none" aria-hidden="true">{habit.icon}</span>
              {/if}
              <span class="truncate font-semibold">{habit.label}</span>
            </span>
            <span class="meta flex items-baseline gap-3 normal-case">
              {#if run > 0}
                <span data-streak={run}>🔥 {runLabel(habit, run)}</span>
              {:else}
                <!-- Not hidden at zero: this is a list somebody opened on
                     purpose, so a habit with no run owes them where it stands
                     rather than vanishing. -->
                <span data-streak={run}>
                  🔥 {standing} of {habit.target}
                  {habit.period === 'day' ? 'today' : `this ${habit.period}`}
                </span>
              {/if}
            </span>
            {#if best > 0}
              <span class="meta normal-case text-haze" data-best={best}>
                ⚡ best {runLabel(habit, best)}
              </span>
            {/if}
          </a>
        {/each}
      </div>
    </section>
  {/if}
</section>
</Frame>
