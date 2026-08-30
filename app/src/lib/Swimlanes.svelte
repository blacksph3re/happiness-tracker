<script>
  import PointerLabel from './PointerLabel.svelte'
  import { clockOfSeconds, formatDuration } from './clock.js'
  import { pointerLabel } from './pointer-label.svelte.js'

  /**
   * Spans of a day drawn as lanes, with an hour axis and a pointer label.
   *
   * In the shared zone because all three swimlanes are this component: one lane
   * per project, one lane per day, and the focus strip. The behaviour they share
   * is not the drawing — that is easy — but the axis thinning and the label,
   * which is a pointer/pin/dismiss machine with three global listeners and a
   * phone caveat behind every one of them. Three copies of that is three places
   * for a tap to stop working on a phone and nowhere else.
   *
   * Purely presentational: it takes lanes and draws them. Where the spans come
   * from, what a lane means and what a span is called are the caller's, which is
   * what lets a session and a pomodoro share it without either knowing about
   * the other.
   *
   * A span is `{ key, from, to, colour, name, detail }`, where `from` and `to`
   * are seconds since local midnight and `detail` is the second line of the
   * label. A lane is `{ key, label, colour, total, spans }`.
   */

  let {
    lanes = [],
    window: axis = { from: 0, to: 86_400 },
    /** Seconds since midnight to draw a "now" line at, or null for none. */
    marker = null,
  } = $props()

  const HOUR = 3600

  const span = $derived(Math.max(HOUR, axis.to - axis.from))

  /** How wide the lanes are, so the axis can be thinned to fit them. */
  let laneWidth = $state(600)

  /** Pixels an hour label needs to itself before the next one crowds it. */
  const MIN_TICK_GAP = 56

  /** Hour marks across the axis, thinned to whatever the screen can hold. */
  const ticks = $derived.by(() => {
    const hours = span / HOUR
    // Spacing by hours alone is what made a phone draw six labels into 180px.
    const perHour = laneWidth / hours
    const step = [1, 2, 3, 4, 6, 12].find((n) => n * perHour >= MIN_TICK_GAP) ?? 12
    const marks = []
    for (let at = Math.ceil(axis.from / HOUR) * HOUR; at <= axis.to; at += HOUR) {
      if ((at / HOUR) % step === 0) marks.push(at)
    }
    return marks
  })

  /** Where a moment sits across the axis, as a percentage. */
  function position(seconds) {
    return ((seconds - axis.from) / span) * 100
  }

  /**
   * The label, and the pin/dismiss machine behind it.
   *
   * Shared with the streak grid, which wants exactly this behaviour over a very
   * different picture — the drawing was never the hard part.
   */
  const tip = pointerLabel({ within: '[data-span]' })
</script>

<!-- The axis and every lane share one grid, so a bar and its hour line up
     whatever the label column ends up measuring. -->
<div class="grid grid-cols-[5rem_1fr] items-center gap-y-1 sm:grid-cols-[10rem_1fr]">
  <span></span>
  <div class="relative h-5" bind:clientWidth={laneWidth}>
    {#each ticks as tick (tick)}
      <span
        class="meta absolute -translate-x-1/2 whitespace-nowrap"
        style:left="{position(tick)}%"
      >
        {clockOfSeconds(tick)}
      </span>
    {/each}
  </div>

  {#each lanes as lane (lane.key ?? 'untagged')}
    <span class="min-w-0 pr-3">
      <span class="flex items-center gap-2">
        {#if lane.colour}
          <span
            class="size-2.5 shrink-0 rounded-full"
            style:background="var(--color-{lane.colour}, var(--color-dusk-lift))"
          ></span>
        {/if}
        <span class="truncate text-sm font-medium">{lane.label}</span>
      </span>
      <span class="meta numeral ml-4.5 block">{formatDuration(lane.total)}</span>
    </span>

    <div
      class="relative h-10 overflow-hidden rounded-md border border-white/5 bg-ink"
      data-lane={lane.key}
    >
      {#each ticks as tick (tick)}
        <span class="absolute inset-y-0 w-px bg-white/5" style:left="{position(tick)}%"></span>
      {/each}

      <!-- Keyed on whatever identity the caller gave the span. A session
           recorded offline has no row id until it syncs, so two of them in one
           lane would both key as `undefined` — and Svelte refuses duplicate
           keys by throwing, mid-render, leaving half the page showing the
           window it was on before. -->
      {#each lane.spans as shown (shown.key)}
        {@const drawnTo = Math.min(shown.to, axis.to)}
        {@const clipped = shown.to > axis.to}
        <!-- Pointer events rather than mouse ones, so a tap answers on a phone
             too — where a `title` never appeared at all. The span is not
             focusable and carries an `aria-label` instead: it is a picture of
             data that is also listed as text beside it. -->
        <!-- A quarter-hour session is a sliver at day scale, so every bar keeps
             a floor width: a span that happened must be visible. -->
        <span
          role="img"
          aria-label="{shown.name} · {shown.detail}"
          data-span={shown.key}
          class="absolute inset-y-1 rounded-sm {clipped ? 'rounded-r-none' : ''}"
          style:left="{position(shown.from)}%"
          style:width="{Math.max(0, position(drawnTo) - position(shown.from))}%"
          style:min-width="3px"
          style:background="var(--color-{shown.colour}, var(--color-dusk-lift))"
          style:opacity={shown.faded ? 0.55 : 0.85}
          onpointerdown={(event) => tip.follow(shown, event)}
          onpointerenter={(event) => tip.drift(shown, event)}
          onpointermove={(event) => tip.drift(shown, event)}
          onpointerleave={(event) => tip.release(event)}
        ></span>
      {/each}

      {#if marker !== null && marker >= axis.from && marker <= axis.to}
        <span
          class="absolute inset-y-0 -ml-px w-0.5 bg-ember"
          style:left="{position(marker)}%"
        ></span>
      {/if}
    </div>
  {/each}
</div>

<PointerLabel {tip} />
