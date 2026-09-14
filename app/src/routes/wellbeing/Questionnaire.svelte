<script>
  import Frame from '../../lib/Frame.svelte'
  import { COLUMN } from '../../lib/wellbeing/column.js'
  import { swipe } from '../../lib/swipe.js'
  import { flush } from '../../lib/sync.js'
  import Ladder from '../../lib/wellbeing/Ladder.svelte'
  import { link } from '../../lib/router.js'
  import { attempt } from '../../lib/api.js'
  import {
    answers as answerStore,
    catalogueDetails,
    catalogues as catalogueStore,
    ensureAnswers,
    ensureCatalogue,
    ensureCatalogues,
    ensureMe,
    me as account,
    saveAnswer,
  } from '../../lib/store.js'
  import { resource } from '../../lib/resource.svelte.js'
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

  let index = $state(0)
  let leaving = $state(false)

  // The URL is the only record of which day is open. Holding it in state as
  // well meant two copies to keep in step, and the effect that reconciled them
  // could undo a change made anywhere that did not also update the URL.
  const day = $derived($query.get('day') ?? today())

  // Which day `index` was last placed for. Bookkeeping rather than a second
  // copy of the day: it says which day the cursor belongs to, not what is open.
  let shownDay = null

  // Whether the reader has moved the cursor themselves on this day. Set by
  // `flipTo` and `step`, which every reader-driven move goes through; the
  // placement below assigns `index` directly and so never marks itself.
  let steered = false

  /**
   * Which catalogue this page is about, and what it holds — read from the
   * store, never copied out of a loader.
   *
   * Assigning `catalogue = await ensureCatalogue(id)` is what made this page
   * wait for the network before it would draw anything: until the await
   * returned there was nothing on the component to count, so "not loaded yet"
   * and "no questions" were the same state and the only safe thing to show was
   * an ellipsis. The device has had the answer in its snapshot the whole time.
   */
  const catalogueId = $derived(
    $account?.default_catalogue_id ?? ($catalogueStore ?? [])[0]?.id ?? null
  )
  const catalogue = $derived(catalogueId ? ($catalogueDetails[catalogueId] ?? null) : null)

  /**
   * The day's answers, read from the shared history rather than copied from it.
   *
   * `saveAnswer` moves this store before it returns, so a tap is reflected here
   * without the page keeping its own optimistic copy — one fewer place for the
   * same fact to be, and what lets a day already answered draw from the
   * snapshot instead of appearing blank until a read lands.
   */
  const answers = $derived(
    Object.fromEntries(
      $answerStore.filter((row) => row.day === day).map((row) => [row.question_id, row])
    )
  )

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

  /**
   * Start the reads. Nothing here decides what is drawn — the store does.
   *
   * Chained rather than parallel: which catalogue to read comes out of the
   * account. On a device that has seen this account every one of them is
   * already on screen from the snapshot before the first of these answers.
   */
  const loaded = resource(
    () => null,
    async () => {
      const me = await ensureMe()
      const id = me?.default_catalogue_id ?? (await ensureCatalogues())?.[0]?.id
      // No toast, and no error: an account with no catalogue is a state a
      // person can deliberately arrive at by deleting their last one, and the
      // page says so below rather than reporting it as something gone wrong.
      if (id) await ensureCatalogue(id)
      await ensureAnswers()
    },
    { name: 'questionnaire' }
  )

  // True only while there is genuinely nothing to draw, never merely because a
  // request is out. See `catalogue` above for what this page used to do.
  const loading = $derived(loaded.loading && questions.length === 0)

  /**
   * Open a day on its first unanswered question.
   *
   * A *placement*, not a position, and the one line here that the two derived
   * values above make delicate. `answers` moves the instant a tap is saved, so
   * the same calculation left to re-run would carry the cursor to the next
   * *gap* on every answer — answering the first question of a day whose second
   * is already filled would land on the third, which is precisely what
   * `advance()` exists to rule out.
   *
   * So it runs while two things are true, and stops for good once either ends:
   *
   * - **Until the reader steers.** `flipTo` and `step` are every way a person
   *   moves through the run, and either one ends the placement for that day.
   * - **Only while the first read is outstanding.** This is the half a day
   *   guard alone got wrong: a cold load renders the questions the moment the
   *   *catalogue* lands, which is a round trip before the day's answers do, so
   *   latching there opened every online visit on question one however much of
   *   the day was already filled. Revising it while the read is in flight is
   *   what lets a snapshot place it at once and a cold load place it correctly.
   */
  $effect(() => {
    if (questions.length === 0) return
    if (day !== shownDay) {
      shownDay = day
      steered = false
    } else if (steered || !loaded.loading) return
    // Opening a finished day shows it for review rather than redirecting: only
    // answering the last question forwards to the stats page.
    index = Math.max(questions.findIndex((q) => !answers[q.id]), 0)
  })

  function record(payload) {
    // A second tap during the exit animation would answer the question that is
    // already leaving and skip the next one entirely.
    if (leaving) return
    const question = current

    // Queued, not sent: the answer is on the device before this returns, and
    // reaches the server whenever there is one to reach. The next question
    // opens either way.
    //
    // Nothing is re-read afterwards. A day's first answer used to be followed
    // by a fetch, because the server wrote the auto-tracked values alongside it
    // and only a re-read had them; those are computed from the day now, so the
    // request had nothing left to bring back.
    saveAnswer({
      day,
      local_hour: localHour(),
      question_id: question.id,
      ...payload,
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
    steered = true
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
    steered = true
    const next = index + delta
    // The closing card is the last position, so stepping forward can reach it.
    if (next >= 0 && next <= questions.length) index = next
  }

  // The question steppers sit at the outer edges of the run, so each is sized
  // to its own label rather than to a shared column.
  const STEPPER =
    'btn-outline meta transition disabled:cursor-not-allowed disabled:opacity-30'

  // Small enough to read as part of the date line it flanks.
  const DAY_STEP =
    'meta rounded-md border border-white/15 px-2 py-1 leading-none transition ' +
    'group-hover:border-white/40'

  // The 44px the arrow is aimed with, around the 26×21 it is drawn at. The
  // negative margin gives the row back exactly what the size took from it, and
  // it reaches up rather than evenly: the header's next line sits 8px below and
  // paints over anything reaching further, so the reach down is exactly that
  // gap and the rest goes into the page's own top space. The top padding keeps
  // the drawn box where it was.
  const DAY_STEP_HIT =
    'group -mx-[9px] -mt-[15px] -mb-[8px] flex size-11 items-start justify-center pt-[15px]'

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

<Frame column={COLUMN}>
<!-- No hint on screen: the arrows and the progress bar already say the run has
     an order, and the gesture is the same one the record uses. See `swipe` for
     why this is ignored rather than given a role. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  use:swipe={{ onswipe: step, ignore: 'input[type="range"]' }}
>
  {#if loading}
    <p class="meta">Loading your questions…</p>
  {:else if !catalogue}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h1 class="text-2xl font-bold">No questions yet</h1>
      <p class="mt-2 text-haze">
        Start from a set, or write your own.
      </p>
      <a
        href="/questions"
        use:link
        class="btn-filled mt-5 inline-block"
      >
        Set up your questions
      </a>
    </div>
  {:else if !current && !onClosingCard}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h1 class="text-2xl font-bold">Nothing to answer</h1>
      <p class="mt-2 text-haze">
        No active questions yet.
      </p>
      <a
        href="/questions"
        use:link
        class="btn-filled mt-5 inline-block"
      >
        Add questions
      </a>
    </div>
  {:else}
    <header class="mb-8 flex flex-col gap-2">
      <!-- The arrows sit either side of the date they move, sized to it: they
           belong to that line rather than being a separate control block. -->
      <div class="flex items-center gap-4">
        <button class={DAY_STEP_HIT} aria-label="Previous day" onclick={() => changeDay(-1)}>
          <span class={DAY_STEP}>←</span>
        </button>
        <p class="meta">{dayLabel(day)}</p>
        <button class={DAY_STEP_HIT} aria-label="Next day" onclick={() => changeDay(1)}>
          <span class={DAY_STEP}>→</span>
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
            All answered for this day.
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
            class="group -mx-[3px] -my-[19px] flex-1 cursor-pointer px-[3px] py-[19px]"
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
            {complete ? 'All answered.' : `${remaining} still open.`}
          </p>
          <a
            href="/stats"
            use:link
            class="btn-filled"
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
</Frame>
