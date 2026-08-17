<script>
  import { get } from 'svelte/store'
  import { swipe } from '../../lib/swipe.js'
  import { flush } from '../../lib/sync.js'
  import Ladder from '../../lib/wellbeing/Ladder.svelte'
  import { link } from '../../lib/router.js'
  import { attempt } from '../../lib/api.js'
  import {
    answers as answerStore,
    ensureAnswers,
    ensureCatalogue,
    ensureCatalogues,
    ensureMe,
    refreshDay,
    saveAnswer,
  } from '../../lib/store.js'
  import { dayLabel, localHour, shiftDay, today } from '../../lib/day.js'
  import { ANSWER_MIN_HEIGHT } from '../../lib/layout.js'
  import { answerRatio, tint } from '../../lib/wellbeing/scale.js'
  import { pushToast } from '../../lib/toasts.js'
  import { navigate, query } from '../../lib/router.js'

  // How long a card takes to leave. Used for both the animation and the wait
  // before the next card is put in its place: two numbers that must agree, so
  // there is only one of them.
  const FLIP_MS = 150

  // The gap between progress segments in pixels, matching the `gap-1.5` on the
  // row. Needed as a number because the sliding ring steps by one segment plus
  // one gap, and a class name built at runtime would generate no CSS at all.
  const SEGMENT_GAP = 6

  let catalogue = $state(null)
  let answers = $state({})
  let index = $state(0)
  let loading = $state(true)
  let leaving = $state(false)

  // The URL is the only record of which day is open. Holding it in state as
  // well meant two copies to keep in step, and the effect that reconciled them
  // could undo a change made anywhere that did not also update the URL.
  const day = $derived($query.get('day') ?? today())

  // Which day's answers are currently in `answers`. Bookkeeping rather than a
  // second copy of the day: it says what has been loaded, not what is open.
  let shownDay = null

  const questions = $derived(
    catalogue ? catalogue.questions.filter((q) => q.active && q.origin === 'asked') : []
  )
  const current = $derived(questions[index] ?? null)
  // One past the last question is the closing card: the day is finished, and
  // the reader decides what happens next rather than being sent somewhere.
  const onClosingCard = $derived(questions.length > 0 && index >= questions.length)
  const answeredCount = $derived(questions.filter((q) => answers[q.id]).length)
  const complete = $derived(questions.length > 0 && answeredCount === questions.length)
  const remaining = $derived(questions.length - answeredCount)

  // The whole catalogue is fetched once. Everything after this is a write, so
  // moving between questions never touches the network.
  $effect(() => {
    load()
  })

  // Any change of day - a stepper, a link from the record, the Back button -
  // arrives as a change of URL, and is answered in exactly one place.
  $effect(() => {
    if (catalogue && day !== shownDay) loadDay()
  })

  /** Fetch the user's catalogue once, then the answers already given for the day. */
  async function load() {
    loading = true
    try {
      await loadCatalogue()
    } finally {
      // Without the finally, one failed request leaves the page stuck on
      // "Loading…" with no way back short of a manual reload.
      loading = false
    }
  }

  /** Resolve which catalogue to show and pull it down with its questions. */
  async function loadCatalogue() {
    const account = await ensureMe()
    if (!account) return
    let catalogueId = account.default_catalogue_id
    if (!catalogueId) {
      const all = await ensureCatalogues()
      catalogueId = all?.[0]?.id
    }
    // No toast, and no error: an account with no catalogue is a state a person
    // can deliberately arrive at by deleting their last one, and the page says
    // so below rather than reporting it as something gone wrong.
    if (!catalogueId) return
    catalogue = await ensureCatalogue(catalogueId)
    await loadDay()
  }

  /** Load the answers already recorded for `day` and open the first gap. */
  async function loadDay() {
    shownDay = day
    // Read from the shared history rather than a per-day request: the store
    // already holds it, and every other view stays in step with what is typed.
    const rows = (await ensureAnswers()) ?? []
    answers = Object.fromEntries(
      rows.filter((row) => row.day === day).map((row) => [row.question_id, row])
    )
    // Opening a finished day shows it for review rather than redirecting: only
    // answering the last question forwards to the stats page.
    index = Math.max(questions.findIndex((q) => !answers[q.id]), 0)
  }

  function record(payload) {
    // A second tap during the exit animation would answer the question that is
    // already leaving and skip the next one entirely.
    if (leaving) return
    const question = current
    answers = { ...answers, [question.id]: { question_id: question.id, ...payload } }

    // Whether this is the first thing recorded on this day, read before the
    // cache is told about it: the server answers the day's first write by also
    // writing the auto-tracked values, and only a re-read has those.
    const opensTheDay = !get(answerStore).some((row) => row.day === day)
    // Queued, not sent: the answer is on the device before this returns, and
    // reaches the server whenever there is one to reach. The next question
    // opens either way.
    // Chained on the queue draining, not on the answer being recorded: the
    // auto-tracked values are written by the *server* alongside the day's first
    // answer, so re-reading before it has one is a request that can only come
    // back without them.
    saveAnswer({
      day,
      local_hour: localHour(),
      question_id: question.id,
      ...payload,
    })
      .then(() => flush())
      .then(() => {
        if (opensTheDay) refreshDay(day)
      })

    advance()
  }

  /**
   * Turn the page after an answer: always to the next question in order.
   *
   * Deliberately not "the next unanswered one". Jumping over questions already
   * answered makes the run unpredictable - the same tap lands somewhere
   * different depending on what the day already holds - and makes correcting
   * several answers awkward. The closing card is simply the position after the
   * last question, reached the same way as any other.
   */
  function advance() {
    flipTo(Math.min(index + 1, questions.length))
  }

  /** Turn the page to `next`, letting the current card leave first. */
  function flipTo(next) {
    leaving = true
    setTimeout(() => {
      index = next
      leaving = false
    }, FLIP_MS)
  }

  /**
   * Open the question a progress segment stands for.
   *
   * @param {number} position Index of the question to open.
   */
  function jumpTo(position) {
    if (leaving || position === index) return
    flipTo(position)
  }

  function step(delta) {
    const next = index + delta
    // The closing card is the last position, so stepping forward can reach it.
    if (next >= 0 && next <= questions.length) index = next
  }

  // The question steppers sit at the outer edges of the run, so each is sized
  // to its own label rather than to a shared column.
  const STEPPER =
    'meta rounded-md border border-white/15 px-4 py-2 transition ' +
    'hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-30'

  // Small enough to read as part of the date line it flanks.
  const DAY_STEP =
    'meta rounded-md border border-white/15 px-2 py-1 leading-none transition ' +
    'hover:border-white/40'

  /**
   * Move to another day by changing the URL and nothing else.
   *
   * Replace rather than push: stepping through a week should not bury the
   * previous page under seven history entries.
   *
   * @param {number} delta Days to move, negative for the past.
   */
  function changeDay(delta) {
    navigate(`/answer?day=${shiftDay(day, delta)}`, { replace: true })
  }
</script>

<!-- No hint on screen: the arrows and the progress bar already say the run has
     an order, and the gesture is the same one the record uses. See `swipe` for
     why this is ignored rather than given a role. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  class="mx-auto w-full max-w-5xl px-5 py-8"
  use:swipe={{ onswipe: step, ignore: 'input[type="range"]' }}
>
  {#if loading}
    <p class="meta">Loading your questions…</p>
  {:else if !catalogue}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h1 class="text-2xl font-bold">No questions yet</h1>
      <p class="mt-2 text-haze">
        Your questions are yours to shape. Build a set from a starting point, or
        write your own from scratch.
      </p>
      <a
        href="/questions"
        use:link
        class="mt-5 inline-block rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift"
      >
        Set up your questions
      </a>
    </div>
  {:else if !current && !onClosingCard}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h1 class="text-2xl font-bold">Nothing to answer</h1>
      <p class="mt-2 text-haze">
        This catalogue has no active questions yet. You can add some on the
        questions page.
      </p>
      <a
        href="/questions"
        use:link
        class="mt-5 inline-block rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift"
      >
        Add questions
      </a>
    </div>
  {:else}
    <header class="mb-8 flex flex-col gap-2">
      <!-- The arrows sit either side of the date they move, sized to it: they
           belong to that line rather than being a separate control block. -->
      <div class="flex items-center gap-2">
        <button class={DAY_STEP} aria-label="Previous day" onclick={() => changeDay(-1)}>
          ←
        </button>
        <p class="meta">{dayLabel(day)}</p>
        <button class={DAY_STEP} aria-label="Next day" onclick={() => changeDay(1)}>
          →
        </button>
      </div>

      {#if complete && !onClosingCard}
        <!-- Between the date and the question: it is a fact about the day, so it
             belongs with the day rather than floating above the scale. -->
        <div
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                 border-dusk-lift/40 bg-dusk/20 px-5 py-3"
        >
          <p class="text-sm">
            Every question is answered for this day. Tap any value to change it.
          </p>
          <a
            href="/stats"
            use:link
            class="meta rounded-md border border-white/20 px-3 py-2 hover:border-white/40"
          >
            See patterns →
          </a>
        </div>
      {/if}

      <!-- The heading reserves the space a longest-allowed prompt needs, so a
           two- or three-line question does not push the answer scale down the
           page on that question alone, and is centred in it so a one-line
           question is not pinned to the top with the gap all below. -->
      <div class="flex min-w-0 flex-col justify-center md:min-h-30">
        <h1 class="text-3xl font-bold tracking-tight md:text-4xl">
          {#if !onClosingCard}
            {current.prompt}
          {:else if complete}
            That is the day recorded
          {:else}
            End of the questions
          {/if}
        </h1>
      </div>
    </header>

    <!-- Progress reads as the accumulating record, not a percentage bar. Each
         answered segment carries the tint of the band that was tapped, and is
         the quickest way back to the question it stands for. -->
    <!-- A nav rather than a group: these move you between questions, and the
         ladder below is already the group of controls that answer one. -->
    <nav class="mb-6 flex items-center gap-1.5" aria-label="Questions in this day">
      <div class="relative flex flex-1 items-center gap-1.5">
        {#each questions as question, position (question.id)}
          {@const ratio = answerRatio(question, answers[question.id])}
          <!-- The bar itself is 6px tall, which is nothing to aim at on a phone.
               The padding gives it a real hit area and the negative margin keeps
               the row the height it looks. -->
          <button
            type="button"
            class="group -my-2 flex-1 cursor-pointer py-2"
            aria-label="Question {position + 1}: {question.prompt}"
            aria-current={position === index ? 'step' : undefined}
            onclick={() => jumpTo(position)}
          >
            <span
              class="block h-1.5 rounded-full transition group-hover:brightness-125
                     {ratio === null ? 'bg-white/12' : ''}"
              style:background={ratio === null ? undefined : tint(ratio)}
            ></span>
          </button>
        {/each}

        <!-- One ring for the whole bar, slid to whichever question is open,
             rather than a ring per segment switched on and off. Moving it is
             what makes the change read as travel along the run instead of two
             unrelated things fading. -->
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 h-1.5 rounded-full ring-1 ring-ember
                 ease-out {onClosingCard ? 'opacity-0' : 'opacity-100'}"
          style:width="calc((100% - {(questions.length - 1) * SEGMENT_GAP}px) / {questions.length})"
          style:transform="translate(calc({Math.min(
            index,
            questions.length - 1
          )} * (100% + {SEGMENT_GAP}px)), -50%)"
          style:transition="transform {FLIP_MS}ms, opacity {FLIP_MS}ms"
        ></span>
      </div>

      <span class="meta ml-3 shrink-0">
        {onClosingCard ? 'Done' : `${index + 1}/${questions.length}`}
      </span>
    </nav>

    <!-- `leaving` is published because it, not the opacity it drives, is what
         decides whether a tap counts: the flag is cleared by a timer while the
         fade is a CSS transition, so a test reading the opacity can believe the
         card has settled while `record` is still dropping taps. -->
    <div
      data-card
      data-leaving={leaving}
      class="rounded-xl p-3 ring-1 ring-ember/45 transition-all ease-out
             {leaving ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100'}"
      style:transition-duration="{FLIP_MS}ms"
    >
      {#if onClosingCard}
        <!-- A card in the same frame as the questions, so finishing is another
             turn of the page rather than the app navigating on your behalf. -->
        <div
          class="flex flex-col items-start justify-center gap-4 px-5 py-6 md:px-8
                 {ANSWER_MIN_HEIGHT}"
        >
          <p class="numeral text-5xl">
            {answeredCount}<span class="text-haze">/{questions.length}</span>
          </p>
          <p class="max-w-md text-haze">
            {#if complete}
              Every question for {day === today() ? 'today' : dayLabel(day)} is
              answered. Step back to change any of them, or see how the last weeks
              have gone.
            {:else}
              {remaining}
              {remaining === 1 ? 'question is' : 'questions are'} still open. Step back
              to answer {remaining === 1 ? 'it' : 'them'}, or leave the day as it is.
            {/if}
          </p>
          <a
            href="/stats"
            use:link
            class="rounded-lg bg-dusk px-5 py-3 font-semibold transition hover:bg-dusk-lift"
          >
            See patterns →
          </a>
        </div>
      {:else}
        <Ladder question={current} value={answers[current.id]} onanswer={record} />
      {/if}
    </div>

    <footer class="mt-6 flex items-center justify-between gap-2">
      <button class={STEPPER} disabled={index === 0} onclick={() => step(-1)}>
        ← Back
      </button>
      <button
        class={STEPPER}
        disabled={index >= questions.length}
        onclick={() => step(1)}
      >
        Skip →
      </button>
    </footer>
  {/if}
</section>
