<script>
  import { clockOfSeconds, formatDuration } from './clock.js'

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
   * What the pointer is over, and where to put the label for it.
   *
   * A `title` attribute was doing this job, and doing it badly: the browser
   * waits about a second before showing one, shows it wherever it likes, and on
   * a phone never shows it at all. The charts on the same page answer instantly
   * through their own tooltip, so this is the same answer in the same shape.
   */
  let hovered = $state(null)

  /**
   * Whether the label is held open by a tap rather than by the pointer.
   *
   * A finger has no hover: it arrives, and then it is gone. ECharts answers a
   * tap by leaving the tooltip up until something else is tapped, so a lane
   * does the same — otherwise the label flashes for exactly as long as the
   * finger is down, which is how "hovering does not work on mobile" looks.
   */
  let pinned = $state(false)

  function follow(shown, event) {
    // A mouse leaving un-pins; a pointer that never hovers cannot, so a tap
    // elsewhere is what closes a pinned label. See the window handler below.
    if (event.pointerType !== 'mouse') pinned = true
    hovered = { name: shown.name, detail: shown.detail, x: event.clientX, y: event.clientY }
  }

  /** Track the pointer without re-pinning, so a mouse move stays a hover. */
  function drift(shown, event) {
    if (event.pointerType === 'mouse') follow(shown, event)
  }

  function release(event) {
    if (event.pointerType === 'mouse' && !pinned) hovered = null
  }

  // `globalThis`, not `window`: this component takes a prop named `window` —
  // the stretch of the day the axis covers — and reaching for `addEventListener`
  // on that one throws where the whole timeline renders.
  //
  // Captured, so it runs before the span's own handler can re-pin: a tap that
  // lands on another block should move the label rather than close it.
  $effect(() => {
    const put = () => {
      pinned = false
      hovered = null
    }
    const dismiss = (event) => {
      if (!pinned) return
      // The label itself counts as elsewhere: tapping it is how it is put away.
      if (event.target?.closest?.('[data-span]')) return
      put()
    }
    // A pinned label is positioned against the viewport, so scrolling would
    // otherwise carry it down the page over blocks it no longer describes —
    // stuck to the screen with no way left to be rid of it. Scrolling is a
    // clear enough "moved on", so it goes.
    const leave = () => {
      if (pinned) put()
    }
    globalThis.addEventListener('pointerdown', dismiss, true)
    globalThis.addEventListener('scroll', leave, { capture: true, passive: true })
    return () => {
      globalThis.removeEventListener('pointerdown', dismiss, true)
      globalThis.removeEventListener('scroll', leave, { capture: true })
    }
  })
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
          onpointerdown={(event) => follow(shown, event)}
          onpointerenter={(event) => drift(shown, event)}
          onpointermove={(event) => drift(shown, event)}
          onpointerleave={release}
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

<!-- Fixed to the viewport, not to the lane: a lane clips its own overflow, so
     anything positioned inside it would be cut off at the edges — which is
     where a label is most often needed. Translated up and right of the pointer,
     and inert, so it can never sit between the pointer and the bar it
     describes. -->
{#if hovered}
  <!-- Inert while it follows a pointer, so it can never sit between the cursor
       and the block it describes; tappable once pinned, or a tap meant to
       dismiss it would fall through onto the block underneath and pin it all
       over again. -->
  <div
    data-span-tip
    class="fixed z-50 max-w-64 rounded-md bg-paper px-3 py-2 text-xs leading-snug
           text-ink shadow-lg {pinned ? 'pointer-events-auto' : 'pointer-events-none'}"
    style:left="{hovered.x + 12}px"
    style:top="{hovered.y - 12}px"
    style:transform="translateY(-100%)"
  >
    <span class="block font-semibold">{hovered.name}</span>
    <span class="block text-ink/70">{hovered.detail}</span>
  </div>
{/if}
