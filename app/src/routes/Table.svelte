<script>
  import { accessToken, api, tryApi } from '../lib/api.js'
  import { dayLabel, shiftDay, today } from '../lib/day.js'
  import { navigate } from '../lib/router.js'
  import { pushToast } from '../lib/toasts.js'

  const WINDOW_STEP = 14
  const LABEL_WIDTH = 17
  const DAY_WIDTH = 8.5

  let rows = $state([])
  let questions = $state([])
  let loading = $state(true)
  let past = $state(WINDOW_STEP)
  let future = $state(7)
  let scroller = $state(null)

  // Open on today at the right-hand edge rather than on the far end: the days
  // past today are empty by definition, so scrolling to them shows nothing.
  $effect(() => {
    if (loading || !scroller) return
    const cell = scroller.querySelector('[data-today]')
    if (!cell) {
      scroller.scrollLeft = scroller.scrollWidth
      return
    }
    const box = scroller.getBoundingClientRect()
    scroller.scrollLeft += cell.getBoundingClientRect().right - box.right + 12
  })

  $effect(() => {
    load()
  })

  async function load() {
    try {
      const catalogues = (await tryApi('/catalogues')) ?? []
      const details = await Promise.all(
        catalogues.map((catalogue) => tryApi(`/catalogues/${catalogue.id}`))
      )
      // Every catalogue, not just the current default: answers recorded before
      // a catalogue switch still belong in the record.
      questions = details.filter(Boolean).flatMap((detail) => detail.questions)
      rows = (await tryApi('/answers')) ?? []
    } finally {
      loading = false
    }
  }

  const answered = $derived([...new Set(rows.map((row) => row.day))].sort())

  // The columns are a continuous stretch of calendar days, not only the days
  // that happen to hold answers, so any day can be opened and filled in.
  const days = $derived.by(() => {
    const start = [shiftDay(today(), -past), answered[0]].filter(Boolean).sort()[0]
    const end = [shiftDay(today(), future), answered.at(-1)].filter(Boolean).sort().at(-1)
    const all = []
    for (let cursor = start; cursor <= end; cursor = shiftDay(cursor, 1)) all.push(cursor)
    return all
  })

  const cells = $derived(
    Object.fromEntries(rows.map((row) => [`${row.question_id}:${row.day}`, row]))
  )

  const shown = $derived(
    questions.filter((question) => rows.some((row) => row.question_id === question.id))
  )

  function render(row, question) {
    if (!row) return '·'
    if (row.option_id != null) {
      const option = question.options.find((o) => o.id === row.option_id)
      return option ? option.label : '—'
    }
    return Number.isInteger(row.value) ? String(row.value) : row.value.toFixed(1)
  }

  async function download() {
    // Touch a JSON endpoint through api() first so an expired access token is
    // refreshed; otherwise the 401 body gets saved as a .xlsx file.
    try {
      await api('/version')
    } catch {
      return
    }
    const response = await fetch('/api/answers/export.xlsx', {
      headers: { Authorization: `Bearer ${accessToken()}` },
    })
    if (!response.ok) {
      pushToast('The export could not be generated.')
      return
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'happiness-answers.xlsx'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
</script>

<section class="mx-auto w-full max-w-6xl px-5 py-8">
  <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <p class="meta">Every answer you have given</p>
      <h1 class="mt-1 text-3xl font-bold tracking-tight">Record</h1>
    </div>
    <div class="flex items-center gap-2">
      <button
        class="meta rounded-md border border-white/15 px-4 py-2 hover:border-white/40"
        onclick={() => (past += WINDOW_STEP)}
      >
        ← Earlier days
      </button>
      <button
        class="meta rounded-md border border-white/15 px-4 py-2 hover:border-white/40"
        onclick={() => (future += WINDOW_STEP)}
      >
        Later days →
      </button>
      <button
        class="meta rounded-md border border-white/15 px-4 py-2 hover:border-white/40"
        onclick={download}
      >
        Download .xlsx
      </button>
    </div>
  </header>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <!-- Days run left to right like a timeline; the table scrolls, the page does not. -->
    <div bind:this={scroller} class="overflow-x-auto rounded-xl border border-white/10">
      <!-- Fixed widths: a long enum label must not stretch its column and knock
           every other day out of alignment. -->
      <table
        class="table-fixed border-collapse text-sm"
        style="width: {LABEL_WIDTH + days.length * DAY_WIDTH}rem"
      >
        <colgroup>
          <col style="width: {LABEL_WIDTH}rem" />
          {#each days as day (day)}
            <col style="width: {DAY_WIDTH}rem" />
          {/each}
        </colgroup>
        <thead>
          <tr>
            <th
              class="meta sticky left-0 z-20 truncate border-r border-white/15 bg-ink-soft
                     px-4 py-3 text-left"
              scope="col"
            >
              Question
            </th>
            {#each days as day (day)}
              <th
                class="meta truncate px-4 py-3 text-left
                       {day === today() ? 'text-ember' : ''}"
                scope="col"
                data-today={day === today() ? '' : undefined}
              >
                {day === today() ? 'Today' : dayLabel(day)}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each shown as question (question.id)}
            <tr class="border-t border-white/8">
              <th
                class="sticky left-0 z-20 truncate border-r border-white/15
                       bg-ink-soft px-4 py-3 text-left
                       font-medium {question.system_key ? 'text-haze' : 'text-paper'}"
                scope="row"
                title={question.prompt}
              >
                {question.prompt}
              </th>
              {#each days as day (day)}
                <td
                  class="numeral truncate px-4 py-3 tabular-nums
                         {cells[`${question.id}:${day}`] ? 'text-paper' : 'text-white/20'}"
                  title={render(cells[`${question.id}:${day}`], question)}
                >
                  {render(cells[`${question.id}:${day}`], question)}
                </td>
              {/each}
            </tr>
          {/each}
          <tr class="border-t border-white/15">
            <th
              class="meta sticky left-0 z-20 truncate border-r border-white/15 bg-ink-soft
                     px-4 py-3 text-left"
              scope="row"
            >
              Answer this day
            </th>
            {#each days as day (day)}
              <td class="px-2 py-3">
                <button
                  class="meta w-full rounded-md border px-3 py-2 transition
                         {day === today()
                    ? 'border-ember/60 text-paper hover:bg-ember/10'
                    : 'border-white/15 hover:border-white/40'}"
                  onclick={() => navigate(`/?day=${day}`)}
                >
                  Answer
                </button>
              </td>
            {/each}
          </tr>
        </tbody>
      </table>
    </div>

    {#if answered.length === 0}
      <p class="mt-4 text-sm text-haze">
        Nothing recorded yet. Pick any day above and start answering.
      </p>
    {/if}
  {/if}
</section>
