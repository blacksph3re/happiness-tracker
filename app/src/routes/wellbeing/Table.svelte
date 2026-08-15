<script>
  import { tick } from 'svelte'

  import { save, toCsv } from '../../lib/download.js'
  import { swipe } from '../../lib/swipe.js'
  import { attempt } from '../../lib/api.js'
  import { ensureAllCatalogues, ensureAnswers } from '../../lib/store.js'
  import { dayLabel, shiftDay, today } from '../../lib/day.js'
  import { navigate } from '../../lib/router.js'
  import { wide } from '../../lib/media.js'
  import { fly } from 'svelte/transition'

  const WINDOW_STEP = 14
  const LABEL_WIDTH = 17
  const DAY_WIDTH = 8.5
  // A row is tall enough for two lines of a long option label, and every row is
  // that tall whatever it holds. Fixed height is what stops the eye having to
  // re-find each answer when one day says "Home" and the next says something
  // three times as long.
  const ROW_HEIGHT = 'min-h-14'

  let rows = $state([])
  let questions = $state([])
  let loading = $state(true)
  let past = $state(WINDOW_STEP)
  let future = $state(7)
  let scroller = $state(null)

  // Mobile shows one day at a time; the day being read, and which way the last
  // move went, so the change animates in the direction of travel.
  let selectedDay = $state(today())
  let direction = $state(1)

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

  /**
   * Move a fortnight through the record, widening it first if there is room.
   *
   * Two things were wrong with these buttons. On a short history they added
   * columns off to the left and left the view where it was, so nothing appeared
   * to happen. On a long one they could add nothing at all — the window already
   * reaches the first day answered — so they did nothing *and* nothing appeared
   * to happen.
   *
   * Defining the move by what is on screen rather than by the window answers
   * both: the column at one edge is carried to the other, which lands on the
   * days just added when there were any, and pages through the ones already
   * there when there were not.
   *
   * @param {'past' | 'future'} side Which way to go.
   */
  async function widen(side) {
    const edge = visibleEdge(side)
    if (side === 'past') past += WINDOW_STEP
    else future += WINDOW_STEP

    await tick()
    const cell = edge && scroller?.querySelector(`[data-column="${edge}"]`)
    if (!cell) return
    const box = scroller.getBoundingClientRect()
    const at = cell.getBoundingClientRect()
    // Carried across: the leftmost column becomes the rightmost, and back.
    scroller.scrollLeft += side === 'past' ? at.right - box.right : at.left - box.left
  }

  /**
   * The day at one edge of what is currently on screen.
   *
   * @param {'past' | 'future'} side
   * @returns {string | undefined} A `YYYY-MM-DD` key, or nothing when the table
   *   has not been drawn yet.
   */
  function visibleEdge(side) {
    if (!scroller) return undefined
    const box = scroller.getBoundingClientRect()
    const columns = [...scroller.querySelectorAll('[data-column]')].filter((cell) => {
      const at = cell.getBoundingClientRect()
      return at.right > box.left && at.left < box.right
    })
    return (side === 'past' ? columns[0] : columns.at(-1))?.dataset.column
  }

  async function load() {
    try {
      // Every catalogue, not just the current default: answers recorded before
      // a catalogue switch still belong in the record.
      const details = await ensureAllCatalogues()
      questions = details.flatMap((detail) => detail.questions)
      rows = (await ensureAnswers()) ?? []
    } finally {
      loading = false
    }
  }

  const answered = $derived([...new Set(rows.map((row) => row.day))].sort())

  const reducedMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  /**
   * Move the mobile view by whole days.
   *
   * @param {number} delta -1 for the previous day, 1 for the next.
   */
  function stepDay(delta) {
    direction = delta
    selectedDay = shiftDay(selectedDay, delta)
  }

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

  /**
   * Save the record as CSV, built from what is on the page.
   *
   * One row per day and one column per question ever answered, which is the
   * orientation analysis tools expect even though the table runs the other way.
   * Rendered here rather than fetched: the file then holds exactly what the
   * screen holds, including anything answered with no connection.
   */
  function download() {
    const columns = shown
    const rows = [['Day', ...columns.map((question) => question.prompt)]]
    for (const day of answered) {
      rows.push([
        day,
        ...columns.map((question) => {
          const cell = cells[`${question.id}:${day}`]
          if (!cell) return null
          if (cell.option_id != null) {
            return question.options.find((o) => o.id === cell.option_id)?.label ?? ''
          }
          // A rating of 4 is a whole number everywhere it is shown, and only
          // became `4.0` on the way out.
          return Number.isInteger(cell.value) ? cell.value : cell.value
        }),
      ])
    }
    save(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), 'happiness-answers.csv')
  }
</script>

<section class="mx-auto w-full max-w-6xl px-5 py-8">
  <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <p class="meta">Every answer you have given</p>
      <h1 class="mt-1 text-3xl font-bold tracking-tight">Record</h1>
    </div>
    <div class="flex items-center gap-2">
      <!-- On a narrow screen these move the single visible day; on a wide one
           they widen the span of columns the table shows. -->
      <button
        class="meta rounded-md border border-white/15 px-4 py-2 hover:border-white/40 md:hidden"
        onclick={() => stepDay(-1)}
      >
        ← Earlier
      </button>
      <button
        class="meta rounded-md border border-white/15 px-4 py-2 hover:border-white/40 md:hidden"
        onclick={() => stepDay(1)}
      >
        Later →
      </button>
      <button
        class="meta hidden rounded-md border border-white/15 px-4 py-2 hover:border-white/40 md:inline-block"
        onclick={() => widen('past')}
      >
        ← Earlier days
      </button>
      <button
        class="meta hidden rounded-md border border-white/15 px-4 py-2 hover:border-white/40 md:inline-block"
        onclick={() => widen('future')}
      >
        Later days →
      </button>
      <!-- Disabled until the record is on screen. The file is rendered from what
           the page holds, so a click before it has anything would hand over a
           header row and nothing else — which is the cost of the export no
           longer coming from the server, and worth spending a `disabled` on. -->
      <button
        class="meta rounded-md border border-white/15 px-4 py-2 hover:border-white/40
               disabled:cursor-not-allowed disabled:opacity-30"
        disabled={loading}
        onclick={download}
      >
        Download .csv
      </button>
    </div>
  </header>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <!-- Narrow screens read one day at a time. Twenty columns of numbers in a
         320 px viewport is not a table anyone can read. -->
    {#if !$wide}
    <!-- The swipe repeats Earlier and Later, which are real buttons; see
         `swipe` for why this is ignored rather than given a role. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div data-day-view use:swipe={{ onswipe: stepDay }}>
      <div class="mb-4 flex items-baseline justify-between">
        <p class="text-lg font-semibold">
          {selectedDay === today() ? 'Today' : dayLabel(selectedDay)}
        </p>
        <p class="meta">swipe to change day</p>
      </div>

      <!-- Two fixed columns: the prompts never move, and only the values slide.
           A day change therefore does not shuffle the questions under the eye. -->
      <div class="flex overflow-hidden rounded-xl border border-white/10">
        <ul class="w-1/2 shrink-0 border-r border-white/15">
          {#each shown as question (question.id)}
            <li
              class="flex {ROW_HEIGHT} items-center border-t border-white/8 px-4 py-2
                     text-sm first:border-t-0
                     {question.origin === 'asked' ? 'text-paper' : 'text-haze'}"
            >
              <span class="line-clamp-2">{question.prompt}</span>
            </li>
          {/each}
        </ul>

        <div class="relative w-1/2 grow overflow-hidden">
          {#key selectedDay}
            <ul
              class="w-full"
              in:fly={{ x: direction * 40, duration: reducedMotion ? 0 : 180 }}
              out:fly={{ x: direction * -40, duration: reducedMotion ? 0 : 120 }}
            >
              {#each shown as question (question.id)}
                {@const cell = cells[`${question.id}:${selectedDay}`]}
                <li
                  class="flex {ROW_HEIGHT} items-center border-t border-white/8 px-4 py-2
                         first:border-t-0
                         {cell ? 'text-paper' : 'text-white/20'}"
                >
                  <!-- Clamped, so "at the office in south east paris" occupies
                       the same box as "Home" and the rows stay put. -->
                  <span
                    class="numeral line-clamp-2 text-sm tabular-nums"
                    title={render(cell, question)}
                  >
                    {render(cell, question)}
                  </span>
                </li>
              {/each}
            </ul>
          {/key}
        </div>
      </div>

      <button
        class="meta mt-4 w-full rounded-md border px-3 py-3 transition
               {selectedDay === today()
          ? 'border-ember/60 text-paper hover:bg-ember/10'
          : 'border-white/15 hover:border-white/40'}"
        onclick={() => navigate(`/answer?day=${selectedDay}`)}
      >
        Answer this day
      </button>
    </div>

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
                data-column={day}
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
                       font-medium {question.origin === 'asked' ? 'text-paper' : 'text-haze'}"
                scope="row"
                title={question.prompt}
              >
                {question.prompt}
              </th>
              {#each days as day (day)}
                <td
                  data-cell="{question.id}:{day}"
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
                  onclick={() => navigate(`/answer?day=${day}`)}
                >
                  Answer
                </button>
              </td>
            {/each}
          </tr>
        </tbody>
      </table>
    </div>
    {/if}

    {#if answered.length === 0}
      <p class="mt-4 text-sm text-haze">
        Nothing recorded yet. Pick any day above and start answering.
      </p>
    {/if}
  {/if}
</section>
