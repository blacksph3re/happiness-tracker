<script>
  import PointerLabel from '../PointerLabel.svelte'
  import { pointerLabel } from '../pointer-label.svelte.js'
  import {
    bestRun,
    habitStreak,
    periodStates,
    runLabel,
    tally,
    targetLabel,
  } from '../habits.js'

  /**
   * One row per habit: a cell per period, coloured by what that period was worth.
   *
   * Plain DOM rather than a chart. It is a row of coloured rectangles, so a
   * chart library adds nothing to the drawing and a great deal to the testing —
   * every hard-won e2e lesson in this repo about `getOption()` polling and
   * charts that are visible before their data has arrived is about asserting on
   * a canvas. Each cell carries its state as an attribute, so a test reads the
   * verdict directly instead of sampling a colour that may still be animating.
   */
  let { habits = [], answers = [], expected = 0, span = 26, offset = 0, from } = $props()

  /**
   * The label, and the pin/dismiss machine behind it.
   *
   * A `title` attribute was doing this and doing it badly — a browser waits
   * about a second, puts it where it likes, and on a phone never shows it at
   * all, which is the whole of "the hover text is not reachable on mobile".
   * The same machine the swimlanes use, which is why it is in the shared zone.
   */
  const tip = pointerLabel({ within: '[data-period]' })

  const rows = $derived(
    habits.map((habit) => {
      const tallies = tally(habit, answers, expected)
      return {
        habit,
        states: periodStates(habit, tallies, { span, from, offset }),
        run: habitStreak(habit, tallies, from),
        best: bestRun(habit, tallies, from),
      }
    })
  )

  /**
   * What a cell says when pointed at, as the label's two lines.
   *
   * Spelled out rather than left to the colour, because the same green means
   * opposite things under the two directions: a met week on a habit you are
   * trying to *stop* is a week you managed not to.
   */
  function describe(habit, state) {
    const verdict = {
      met: 'kept',
      missed: 'missed',
      unrecorded: 'nothing recorded',
      open: 'still open',
    }[state.state]
    if (state.state === 'unrecorded') return { name: state.label, detail: verdict }
    const what =
      habit.synthetic && state.progress !== null
        ? `${Math.round(state.progress * 100)}% of the questions answered`
        : `${state.count} of ${state.target}`
    return { name: state.label, detail: `${verdict} · ${what}` }
  }
</script>

<div class="flex flex-col gap-6" data-streaks>
  {#each rows as { habit, states, run, best } (habit.key)}
    <section data-habit-row={habit.key}>
      <header class="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span class="flex min-w-0 items-baseline gap-2">
          {#if habit.icon}
            <span class="text-lg leading-none" aria-hidden="true">{habit.icon}</span>
          {/if}
          <span class="truncate font-semibold">{habit.label}</span>
          <!-- In words, because a grid of colours cannot say which direction it
               is scoring, and a solid green row under a habit you are trying to
               break means the opposite of the same row under one you are
               building. -->
          <span class="meta shrink-0 normal-case text-haze">{targetLabel(habit)}</span>
        </span>
        <span class="meta flex shrink-0 items-baseline gap-3 normal-case">
          <span data-run={run}>🔥 {runLabel(habit, run)}</span>
          <span class="text-haze" data-best={best}>⚡ best {runLabel(habit, best)}</span>
        </span>
      </header>

      <!-- Scrolls inside itself: a year of daily cells is wider than a phone,
           and the page itself must never scroll sideways. -->
      <div class="overflow-x-auto">
        <div class="flex min-w-full gap-0.5">
          {#each states as state (state.key)}
            {@const said = describe(habit, state)}
            <!-- Pointer events rather than a `title`, so a tap answers on a
                 phone too. `role="img"` with a label, because a cell is a
                 picture of a reading that is also written beside it. -->
            <span
              role="img"
              aria-label="{said.name} · {said.detail}"
              data-state={state.state}
              data-period={state.key}
              data-count={state.count}
              onpointerdown={(event) => tip.follow(said, event)}
              onpointerenter={(event) => tip.drift(said, event)}
              onpointermove={(event) => tip.drift(said, event)}
              onpointerleave={(event) => tip.release(event)}
              class="relative flex h-7 min-w-2 flex-1 items-end overflow-hidden rounded-sm
                     {state.state === 'met'
                       ? 'bg-sage/55'
                       : state.state === 'missed'
                         ? 'bg-alarm/55'
                         : state.state === 'open'
                           ? 'bg-white/5 ring-1 ring-white/20 ring-inset'
                           : 'ring-1 ring-white/8 ring-inset'}"
            >
              <!-- The base says the verdict, the fill says how far — never the
                   other way round. Drawing the fill alone made a week that
                   missed by everything *paler* than one that missed by a
                   little, so the worse outcome looked milder. A null progress
                   is a budget rather than a gap, and fills the cell. -->
              {#if state.state !== 'unrecorded'}
                <span
                  aria-hidden="true"
                  class="w-full {state.state === 'missed'
                    ? 'bg-alarm'
                    : state.state === 'open'
                      ? 'bg-sage/70'
                      : 'bg-sage'}"
                  style:height="{(state.progress ?? 1) * 100}%"
                ></span>
              {/if}
            </span>
          {/each}
        </div>
      </div>

      <p class="meta mt-1 flex justify-between normal-case text-haze">
        <span>{states[0]?.label}</span>
        <span>{states.at(-1)?.label}</span>
      </p>
    </section>
  {/each}
</div>

<PointerLabel {tip} />
