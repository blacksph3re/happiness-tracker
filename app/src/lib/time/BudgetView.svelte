<script>
  import PointerLabel from '../PointerLabel.svelte'
  import { formatDuration, formatSigned } from '../clock.js'
  import { currentDay, dayLabel } from '../day.js'
  import { period } from '../period.js'
  import { pointerLabel } from '../pointer-label.svelte.js'
  import { resource } from '../resource.svelte.js'
  import {
    budgetRecords,
    ensureBudgetRecords,
    projects as projectStore,
    saveDaysOff,
    setBudget,
    tagRules,
    timeEntries,
  } from '../store.js'
  import { breakdownLines, budgetForTag } from './budget.js'
  import { now } from './tick.js'

  /**
   * A contracted tag's hour budget, day by day, newest first.
   *
   * Every day from the budget's start is listed, not only tracked ones: a
   * workday with nothing on it is the thing this view exists to show, so it is
   * drawn in the alarm colour with a way to mark it a day off beside it.
   * Planned days off — after today — stay out of the list so today remains the
   * top record, and wait in one line above it instead.
   *
   * Everything is derived from the store: the sessions, the tag's rule and
   * contract, and the days off and resets, through `budgetDays`, so it paints
   * offline and moves with a running session.
   */
  let { tagId, tags = [], onpick = () => {} } = $props()

  const records = resource(
    () => tagId,
    () => ensureBudgetRecords(),
    { name: 'budget records' }
  )

  const rule = $derived(($tagRules ?? {})[tagId] ?? null)

  const mine = $derived({
    daysOff: $budgetRecords.daysOff.filter((row) => row.tag_id === tagId),
    resets: $budgetRecords.resets.filter((row) => row.tag_id === tagId),
  })

  const rows = $derived(
    budgetForTag({
      tagId,
      rule,
      entries: $timeEntries,
      projects: $projectStore ?? [],
      records: $budgetRecords,
      today: $currentDay,
      asOf: $now,
    })
  )

  /** The balance through yesterday: today counts once it is over. */
  const balance = $derived(rows.at(-1)?.balance ?? 0)

  /** Days off marked for after today, soonest first. */
  const planned = $derived(
    mine.daysOff.filter((row) => row.day > $currentDay).toSorted((a, b) => (a.day < b.day ? -1 : 1))
  )
  let showPlanned = $state(false)

  /**
   * The rows in weeks, newest first, each with its change.
   *
   * A week holding a reset counts only from the reset on: the days before it
   * moved a balance the reset then replaced, and what that balance was is said
   * on the reset's own row instead.
   */
  const weeks = $derived.by(() => {
    const grouped = new Map()
    for (const row of rows.toReversed()) {
      const start = period('week', row.day).start
      if (!grouped.has(start)) grouped.set(start, [])
      grouped.get(start).push(row)
    }
    return [...grouped].map(([start, days]) => {
      const cutoff = days.find((day) => day.reset !== null)?.day ?? start
      return {
        start,
        label: period('week', start).label,
        days,
        change: days
          .filter((day) => !day.open && day.day >= cutoff)
          .reduce((sum, day) => sum + day.counted - day.expected, 0),
      }
    })
  })

  /**
   * The balance each reset replaced: the one the day before it closed on.
   *
   * None for a reset on the budget's first day, which had no balance before it
   * to replace — saying *was 0h 00m* there would be inventing one.
   */
  const replaced = $derived(
    new Map(
      rows.flatMap((row, index) =>
        row.reset !== null && index > 0 ? [[row.day, rows[index - 1].balance]] : []
      )
    )
  )

  const resetOn = $derived(new Map(mine.resets.map((row) => [row.day, row])))

  const KIND_NAMES = { vacation: 'Vacation', sick: 'Sick', other: 'Other', balance: 'Day off' }

  /** What a row is, for its look and for `data-state`. */
  function stateOf(row) {
    if (row.kind === 'workday' && row.counted === 0 && !row.open) return 'untracked'
    return row.kind
  }

  /**
   * A row shows what the day counted and what that did to the balance. What the
   * count is made of, and what the day expected, is in the label on its total:
   * on every line it repeated the contract's hours down the whole list.
   */
  const tip = pointerLabel({ within: '[data-budget-total]' })

  /** The label for a day's total: its parts, and what the contract expected. */
  function explain(row) {
    return { name: row.open ? 'Today' : dayLabel(row.day), lines: breakdownLines(row, rule) }
  }

  /** The same, as one sentence for a screen reader. */
  function spoken(row) {
    const { lines } = explain(row)
    const said = lines.map(([label, value]) => `${label.toLowerCase()} ${value}`).join(', ')
    return `${formatDuration(row.counted)} counted: ${said}`
  }

  function markOff(day, kind = 'vacation') {
    return saveDaysOff([{ tag_id: tagId, day, kind }])
  }

  function clearOff(day) {
    return saveDaysOff([{ tag_id: tagId, day, kind: null }])
  }
</script>

{#if tags.length > 1}
  <div class="mb-4 flex flex-wrap gap-1" role="group" aria-label="Budget of">
    {#each tags as tag (tag.id)}
      <button
        class="meta rounded-md border px-4 py-2 transition
               {tag.id === tagId
          ? 'border-ember bg-ember/10 text-paper'
          : 'border-white/15 hover:border-white/40'}"
        aria-pressed={tag.id === tagId}
        data-budget-tag={tag.id}
        onclick={() => onpick(tag.id)}
      >
        {tag.name}
      </button>
    {/each}
  </div>
{/if}

<div class="mb-4 flex items-baseline justify-between gap-3">
  <p class="meta">Hour budget</p>
  <p
    class="numeral text-3xl font-semibold tabular-nums {balance < 0 ? 'text-alarm' : ''}"
    data-budget-balance
  >
    {formatSigned(balance)}
  </p>
</div>

{#if planned.length}
  <div class="mb-3">
    <button
      class="btn-outline meta w-full flex-wrap content-center justify-start gap-x-1.5 gap-y-1 py-2 text-left"
      aria-expanded={showPlanned}
      data-planned-off
      onclick={() => (showPlanned = !showPlanned)}
    >
      <span class="whitespace-nowrap">
        {planned.length} {planned.length === 1 ? 'day' : 'days'} off planned ·
      </span>
      <span class="whitespace-nowrap">from {dayLabel(planned[0].day)}</span>
    </button>
    {#if showPlanned}
      <ul class="mt-2 flex flex-col rounded-xl border border-white/10 bg-ink-soft py-1">
        {#each planned as row (row.day)}
          <li
            class="flex items-center justify-between gap-3 px-5 py-2"
            data-planned-day={row.day}
          >
            <span>
              <span class="meta">{dayLabel(row.day)}</span>
              <span class="text-sm"> · {KIND_NAMES[row.kind]}</span>
            </span>
            <button
              class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
              aria-label="Clear the day off on {dayLabel(row.day)}"
              onclick={() => clearOff(row.day)}
            >
              <span
                class="meta flex size-8 items-center justify-center rounded-md border
                       border-white/15 transition group-hover:border-white/40"
              >
                ×
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<div class="flex flex-col gap-3">
  {#each weeks as week (week.start)}
    <div data-budget-week={week.start} class="rounded-xl border border-white/10 bg-ink-soft">
      <div class="flex items-baseline justify-between gap-3 px-5 py-3">
        <p class="meta">{week.label}</p>
        <p class="numeral tabular-nums" data-week-change>{formatSigned(week.change)}</p>
      </div>
      <ul class="flex flex-col gap-px border-t border-white/10">
        {#each week.days as row (row.day)}
          {@const state = stateOf(row)}
          <li
            class="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-2
                   {state === 'untracked' ? 'border-l-2 border-alarm bg-alarm/5' : ''}
                   {state === 'rest' || state === 'holiday' || state === 'off'
              ? 'text-haze'
              : ''}"
            data-budget-day={row.day}
            data-state={state}
            data-today={row.open ? '' : undefined}
          >
            <span class="min-w-0 truncate">
              <span class="meta">{row.open ? 'Today' : dayLabel(row.day)}</span>
              {#if state === 'untracked'}
                <span class="text-sm text-alarm"> · Not tracked</span>
              {:else if state === 'holiday'}
                <span class="text-sm"> · {row.name}</span>
              {:else if state === 'off'}
                <span class="text-sm"> · {KIND_NAMES[row.name] ?? 'Day off'}</span>
              {/if}
            </span>

            <span class="ml-auto flex shrink-0 items-center gap-3">
              {#if state === 'untracked'}
                <span class="numeral text-sm text-alarm tabular-nums" data-budget-change>
                  {formatSigned(-row.expected)}
                </span>
                <!-- Two ways to account for the day: a vacation excuses its
                     hours, a day off takes them from the balance — which is
                     what the day already costs, minus the warning. -->
                <button
                  class="btn-outline meta"
                  aria-label="Mark {dayLabel(row.day)} as vacation"
                  onclick={() => markOff(row.day, 'vacation')}
                >
                  Vacation
                </button>
                <button
                  class="btn-outline meta"
                  aria-label="Mark {dayLabel(row.day)} as a day off"
                  onclick={() => markOff(row.day, 'balance')}
                >
                  Day off
                </button>
              {:else if row.open || row.counted || row.expected}
                <!-- No total on a day off taken from the balance with nothing on
                     it: nothing was tracked, and its change already says what it
                     cost. -->
                {#if row.open || row.counted}
                  <span
                    role="img"
                    aria-label={spoken(row)}
                    class="numeral cursor-help text-sm text-haze tabular-nums"
                    data-budget-total
                    onpointerdown={(event) => tip.follow(explain(row), event)}
                    onpointerenter={(event) => tip.drift(explain(row), event)}
                    onpointermove={(event) => tip.drift(explain(row), event)}
                    onpointerleave={(event) => tip.release(event)}
                  >
                    {formatDuration(row.counted)}
                  </span>
                {/if}
                <!-- Today has not changed the balance yet; its slot stays, so
                     the totals above and below it line up. -->
                <span
                  class="numeral min-w-[4.5rem] text-right text-sm tabular-nums"
                  data-budget-change={row.open ? undefined : ''}
                >
                  {row.open ? '' : formatSigned(row.counted - row.expected)}
                </span>
              {/if}
              {#if state === 'off'}
                <button
                  class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
                  aria-label="Clear the day off on {dayLabel(row.day)}"
                  onclick={() => clearOff(row.day)}
                >
                  <span
                    class="meta flex size-8 items-center justify-center rounded-md border
                           border-white/15 transition group-hover:border-white/40"
                  >
                    ×
                  </span>
                </button>
              {/if}
            </span>
          </li>
          {#if resetOn.has(row.day)}
            <!-- Below its day: a reset fixes the balance at the day's *start*,
                 and the list reads backwards in time. -->
            <li
              class="flex items-center justify-between gap-3 bg-dusk/10 px-5 py-2"
              data-budget-reset={row.day}
            >
              <span class="text-sm">
                {`Budget set to ${formatSigned(resetOn.get(row.day).balance_minutes * 60)}` +
                  (replaced.has(row.day) ? ` · was ${formatSigned(replaced.get(row.day))}` : '')}
              </span>
              <button
                class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
                aria-label="Clear the budget set on {dayLabel(row.day)}"
                onclick={() => setBudget({ tag_id: tagId, day: row.day, balance_minutes: null })}
              >
                <span
                  class="meta flex size-8 items-center justify-center rounded-md border
                         border-white/15 transition group-hover:border-white/40"
                >
                  ×
                </span>
              </button>
            </li>
          {/if}
        {/each}
      </ul>
    </div>
  {:else}
    {#if records.loading}
      <p class="meta py-6 text-center">Reading the budget…</p>
    {/if}
  {/each}
</div>

<PointerLabel {tip} />
