<script>
  import { CHIP_COLOURS, chipColour } from './palette.js'

  /**
   * A colour, chosen from the six the app has.
   *
   * The same control the Lists page draws inline, in the same drawing: a 24px
   * dot inside a 44px target, the chosen one ringed in `paper`. It is a
   * component here because a *task* wants it too, and the row of swatches on
   * the modal has one thing the Lists page has no use for — an explicit *take
   * the colour of the thing above me*, which is what `null` means on
   * `todos.colour`.
   *
   * `CHIP_COLOURS` is what a chooser offers; a stored token from a later
   * palette still *draws*, which is `chipColour`'s business and not this one's.
   */
  let {
    /** The chosen token, or null for none. */
    value = null,
    /** Called with a token, or `null` when the inherit choice is taken. */
    onchange = () => {},
    /** What the row is labelled. */
    label = 'Colour',
    /**
     * What choosing nothing means, in words, or null to leave that choice out.
     *
     * A task says *List colour*, because null on a task is not "no colour" —
     * it is the list's, which is what every card and every calendar block drew
     * before tasks could carry one of their own. A control that offered "none"
     * would be promising a card with no colour at all, which is not a state
     * this data has.
     */
    inherit = null,
  } = $props()
</script>

<div class="flex flex-col gap-1.5" data-colour-picker>
  <span class="meta">{label}</span>
  <!-- `flex-wrap` is the safety net the Lists page uses for the same row: six
       44px targets need 264px, and a narrower screen than this app is tested at
       should wrap them rather than scroll the page sideways. -->
  <div
    class="flex flex-wrap items-center"
    role="group"
    aria-label={label}
  >
    {#if inherit}
      <!-- Drawn in the colour it would inherit is deliberately *not* done: this
           choice is about where the colour comes from, and painting it in the
           answer would make the row read as seven colours with two the same. -->
      <button
        type="button"
        data-colour="inherit"
        aria-label={inherit}
        aria-pressed={!value}
        class="meta flex h-11 items-center rounded-md border px-3 whitespace-nowrap
               transition
               {!value ? 'border-paper text-paper' : 'border-white/15 hover:border-white/40'}"
        onclick={() => onchange(null)}
      >
        {inherit}
      </button>
    {/if}
    {#each CHIP_COLOURS as colour (colour)}
      <!-- 44px of target around a 24px dot, which is the technique the task
           card's tickbox and the Lists page's swatches both use: the drawing
           does not change and the reach does. -->
      <button
        type="button"
        data-colour={colour}
        aria-label={`${label} ${colour}`}
        aria-pressed={value === colour}
        class="flex size-11 shrink-0 items-center justify-center"
        onclick={() => onchange(colour)}
      >
        <span
          class="size-6 rounded-full border-2 transition
                 {value === colour ? 'border-paper' : 'border-transparent hover:border-white/40'}"
          style:background={chipColour(colour)}
        ></span>
      </button>
    {/each}
  </div>
</div>
