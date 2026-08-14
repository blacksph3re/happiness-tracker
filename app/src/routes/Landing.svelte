<script>
  import { link } from '../lib/router.js'
  import { elapsed, formatDuration } from '../lib/time/duration.js'
  import { now } from '../lib/time/tick.js'
  import {
    answers as answerStore,
    ensureAnswers,
    ensureCatalogue,
    ensureMe,
    ensureProjects,
    ensureTimeEntries,
    projects as projectStore,
    timeEntries,
  } from '../lib/store.js'
  import { today } from '../lib/day.js'

  /**
   * The one place the two halves meet.
   *
   * Not a menu: each card reports the state of its half before it is touched,
   * so the two most common actions of a day — answer today, stop a timer — are
   * one tap from where you land.
   */

  let loading = $state(true)
  let questions = $state([])

  const day = today()

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

  $effect(() => {
    load()
  })

  async function load() {
    try {
      const [user] = await Promise.all([
        ensureMe(),
        ensureAnswers(),
        ensureProjects(),
        ensureTimeEntries({ start: day, end: day }),
      ])
      if (user?.default_catalogue_id) {
        const detail = await ensureCatalogue(user.default_catalogue_id)
        questions = (detail?.questions ?? []).filter(
          (question) => question.active && question.origin === 'asked'
        )
      }
    } finally {
      loading = false
    }
  }
</script>

<section class="mx-auto w-full max-w-4xl px-5 py-10">
  <p class="meta">Today</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">What are you recording?</h1>

  <div class="grid gap-4 md:grid-cols-2">
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
            {#each running as row (row.entry.id)}
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
  </div>
</section>
