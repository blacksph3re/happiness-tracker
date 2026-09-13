<script>
  /**
   * The drawn 32px box inside a tickbox, for a task's card and a step's row.
   *
   * One component because they are one control to whoever uses them: a tick
   * that draws itself on a card and snaps on a step reads as broken. The step
   * used to write a `✓` glyph where the card drew a path, which is two
   * spellings of one mark, and a glyph cannot be drawn in.
   *
   * The 44px button around it belongs to the caller, because the negative
   * margin that makes it 44 is a decision about the *row* it sits in.
   */
  let {
    done = false,
    /** An icon chosen for the task or step, drawn in place of the tick. */
    icon = null,
    /**
     * Whether this rendering of the tick is the moment it was made, from
     * `justTicked` — only then does it draw itself in rather than appear.
     */
    drawing = false,
  } = $props()
</script>

<span
  class="flex size-8 items-center justify-center rounded-md border border-white/20
         text-base leading-none group-hover:border-white/40
         {done ? 'border-transparent bg-dusk text-paper' : ''}"
>
  {#if icon}
    <span aria-hidden="true">{icon}</span>
  {:else if done}
    <!-- `pathLength="1"` makes the dash arithmetic independent of the shape:
         a dash of one is the whole stroke, and an offset of one hides it. -->
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        class="tick-path {drawing ? 'tick-draw' : ''}"
        d="M2 7.5 5.5 11 12 3.5"
        pathLength="1"
        stroke="currentColor"
        stroke-width="2"
      />
    </svg>
  {/if}
</span>
