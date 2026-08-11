<script>
  import Ladder from '../lib/Ladder.svelte'
  import { link } from '../lib/router.js'
  import { api, tryApi } from '../lib/api.js'
  import { dayLabel, localHour, shiftDay, today } from '../lib/day.js'
  import { answerRatio, tint } from '../lib/scale.js'
  import { pushToast } from '../lib/toasts.js'
  import { navigate, query } from '../lib/router.js'

  let catalogue = $state(null)
  let answers = $state({})
  let index = $state(0)
  let day = $state($query.get('day') ?? today())
  let loading = $state(true)
  let leaving = $state(false)

  const questions = $derived(
    catalogue ? catalogue.questions.filter((q) => q.active && !q.system_key) : []
  )
  const current = $derived(questions[index] ?? null)
  const answeredCount = $derived(questions.filter((q) => answers[q.id]).length)
  const complete = $derived(questions.length > 0 && answeredCount === questions.length)

  // The whole catalogue is fetched once. Everything after this is a write, so
  // moving between questions never touches the network.
  $effect(() => {
    load()
  })

  $effect(() => {
    const requested = $query.get('day')
    if (requested && requested !== day) {
      day = requested
      if (catalogue) loadDay()
    }
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
    const me = await tryApi('/me')
    if (!me) return
    let catalogueId = me.default_catalogue_id
    if (!catalogueId) {
      const all = await tryApi('/catalogues')
      catalogueId = all?.[0]?.id
    }
    if (!catalogueId) {
      pushToast('No catalogue is set up yet. Ask an editor to create one.')
      return
    }
    catalogue = await tryApi(`/catalogues/${catalogueId}`)
    await loadDay()
  }

  /** Load the answers already recorded for `day` and open the first gap. */
  async function loadDay() {
    const rows = await tryApi(`/answers?from=${day}&to=${day}`)
    answers = Object.fromEntries((rows ?? []).map((row) => [row.question_id, row]))
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

    // Fire and forget: the next question opens without waiting for the server.
    api('/answers', {
      method: 'PUT',
      body: { day, local_hour: localHour(), question_id: question.id, ...payload },
    }).catch((error) => pushToast(error.message))

    advance()
  }

  /** Open the next unanswered question, or leave for the stats page when done. */
  function advance() {
    const nextGap = questions.findIndex((q, position) => position > index && !answers[q.id])
    if (nextGap === -1) {
      if (questions.every((q) => answers[q.id])) {
        navigate('/stats')
        return
      }
      // Questions were skipped earlier; go back and pick up the first of them.
      leaving = true
      setTimeout(() => {
        index = questions.findIndex((q) => !answers[q.id])
        leaving = false
      }, 140)
      return
    }
    leaving = true
    setTimeout(() => {
      index = nextGap
      leaving = false
    }, 140)
  }

  function step(delta) {
    const next = index + delta
    if (next >= 0 && next < questions.length) index = next
  }

  // The day pair and the question pair read as one control column on the right,
  // so they share a width and a style rather than each sizing to its own label.
  const STEPPER =
    'meta w-28 rounded-md border border-white/15 px-3 py-2 text-center transition ' +
    'hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-30'

  async function changeDay(delta) {
    day = shiftDay(day, delta)
    // Keep the URL in step so the day survives a reload or a shared link.
    window.history.replaceState({}, '', `/?day=${day}`)
    await loadDay()
  }
</script>

<section class="mx-auto w-full max-w-5xl px-5 py-8">
  {#if loading}
    <p class="meta">Loading your questions…</p>
  {:else if !current}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h1 class="text-2xl font-bold">Nothing to answer</h1>
      <p class="mt-2 text-haze">
        This catalogue has no active questions yet. An editor can add some from the
        catalogue page.
      </p>
    </div>
  {:else}
    <header class="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="meta">{dayLabel(day)}</p>
        <h1 class="mt-1 text-3xl font-bold tracking-tight md:text-4xl">
          {current.prompt}
        </h1>
      </div>
      <!-- ml-auto keeps the pair on the right even when a long prompt pushes it
           onto its own line, where justify-between alone would strand it left. -->
      <div class="ml-auto flex items-center gap-2">
        <button class={STEPPER} onclick={() => changeDay(-1)}>← Day</button>
        <button class={STEPPER} onclick={() => changeDay(1)}>Day →</button>
      </div>
    </header>

    {#if complete}
      <div
        class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border
               border-dusk-lift/40 bg-dusk/20 px-5 py-4"
      >
        <p class="text-sm">Every question is answered for this day. Tap any value to change it.</p>
        <a href="/stats" use:link class="meta rounded-md border border-white/20 px-3 py-2
                                          hover:border-white/50">
          See patterns →
        </a>
      </div>
    {/if}

    <!-- Progress reads as the accumulating record, not a percentage bar. Each
         answered segment carries the tint of the band that was tapped. -->
    <div class="mb-6 flex items-center gap-1.5" aria-label="Progress through today's questions">
      {#each questions as question, position (question.id)}
        {@const ratio = answerRatio(question, answers[question.id])}
        <span
          class="h-1.5 flex-1 rounded-full transition-colors
                 {ratio === null && position === index ? 'bg-ember' : ''}
                 {ratio === null && position !== index ? 'bg-white/12' : ''}
                 {position === index ? 'ring-1 ring-ember' : ''}"
          style:background={ratio === null ? undefined : tint(ratio)}
        ></span>
      {/each}
      <span class="meta ml-3 shrink-0">{index + 1}/{questions.length}</span>
    </div>

    <div
      class="rounded-xl p-3 ring-1 ring-ember/45 transition-all duration-150 ease-out
             {leaving ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100'}"
    >
      <Ladder question={current} value={answers[current.id]} onanswer={record} />
    </div>

    <footer class="mt-6 flex items-center justify-end gap-2">
      <button class={STEPPER} disabled={index === 0} onclick={() => step(-1)}>
        ← Back
      </button>
      <button
        class={STEPPER}
        disabled={index === questions.length - 1}
        onclick={() => step(1)}
      >
        Skip →
      </button>
    </footer>
  {/if}
</section>
