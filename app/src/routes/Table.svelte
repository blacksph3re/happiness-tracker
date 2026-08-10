<script>
  import { accessToken, api, tryApi } from '../lib/api.js'
  import { dayLabel } from '../lib/day.js'
  import { navigate } from '../lib/router.js'
  import { pushToast } from '../lib/toasts.js'

  let rows = $state([])
  let questions = $state([])
  let loading = $state(true)

  $effect(() => {
    load()
  })

  /**
   * Load every answer plus the questions behind them.
   *
   * Questions are gathered from all catalogues, not just the current default:
   * answers recorded before a catalogue switch still belong in the record.
   */
  async function load() {
    try {
      const catalogues = (await tryApi('/catalogues')) ?? []
      const details = await Promise.all(
        catalogues.map((catalogue) => tryApi(`/catalogues/${catalogue.id}`))
      )
      questions = details.filter(Boolean).flatMap((detail) => detail.questions)
      rows = (await tryApi('/answers')) ?? []
    } finally {
      loading = false
    }
  }

  const days = $derived([...new Set(rows.map((row) => row.day))].sort().reverse())

  const cells = $derived(
    Object.fromEntries(rows.map((row) => [`${row.question_id}:${row.day}`, row]))
  )

  const shown = $derived(
    questions.filter((question) =>
      rows.some((row) => row.question_id === question.id)
    )
  )

  /**
   * Format one cell, resolving enum answers back to their option label.
   *
   * @param {object|undefined} row The answer, if one exists.
   * @param {object} question The question it answers.
   * @returns {string} The cell text.
   */
  function render(row, question) {
    if (!row) return '·'
    if (row.option_id != null) {
      const option = question.options.find((o) => o.id === row.option_id)
      return option ? option.label : '—'
    }
    return Number.isInteger(row.value) ? String(row.value) : row.value.toFixed(1)
  }

  /** Download the record as a spreadsheet, refreshing the token if it expired. */
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
    <button
      class="meta rounded-md border border-white/15 px-4 py-2 hover:border-white/40"
      onclick={download}
    >
      Download .xlsx
    </button>
  </header>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else if days.length === 0}
    <div class="rounded-xl border border-white/10 bg-ink-soft p-8">
      <h2 class="text-xl font-bold">No answers yet</h2>
      <p class="mt-2 text-haze">Answer today's questions and they will show up here.</p>
      <button
        class="mt-4 rounded-lg bg-dusk px-4 py-2 font-semibold hover:bg-dusk-lift"
        onclick={() => navigate('/')}
      >
        Start answering
      </button>
    </div>
  {:else}
    <!-- Days run along x, as many as the record holds; the table scrolls, the page does not. -->
    <div class="overflow-x-auto rounded-xl border border-white/10">
      <table class="w-max border-collapse text-sm">
        <thead>
          <tr>
            <th
              class="meta sticky left-0 z-10 bg-ink-soft px-4 py-3 text-left"
              scope="col">Question</th>
            {#each days as day (day)}
              <th class="meta whitespace-nowrap px-4 py-3 text-left" scope="col">
                {dayLabel(day)}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each shown as question (question.id)}
            <tr class="border-t border-white/8">
              <th
                class="sticky left-0 z-10 max-w-64 truncate bg-ink-soft px-4 py-3 text-left
                       font-medium {question.system_key ? 'text-haze' : 'text-paper'}"
                scope="row"
                title={question.prompt}
              >
                {question.prompt}
              </th>
              {#each days as day (day)}
                <td
                  class="numeral px-4 py-3 tabular-nums
                         {cells[`${question.id}:${day}`] ? 'text-paper' : 'text-white/20'}"
                >
                  {render(cells[`${question.id}:${day}`], question)}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
