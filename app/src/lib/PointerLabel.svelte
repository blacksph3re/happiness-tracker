<script>
  /**
   * The label a `pointerLabel()` puts on screen.
   *
   * Fixed to the viewport, not to whatever it describes: a lane and a streak row
   * both clip their own overflow, so anything positioned inside one would be cut
   * off at the edges — which is where a label is most often wanted.
   */
  let { tip } = $props()

  /** Clear of the pointer, so the label never sits under the finger. */
  const GAP = 12

  /** Never flush against the edge of the screen. */
  const EDGE = 8

  /**
   * Keep the label on the screen, shifting it left by however far it would
   * otherwise run off.
   *
   * Fixed positioning is what stops a *row* clipping the label; nothing in it
   * stops the label leaving the screen, and a cell at the right of a streak row
   * drew it 47px off a 390px one.
   *
   * How far it may go depends on how wide the text made it, so this is arithmetic
   * only the browser can do — which is the point of doing it in CSS rather than
   * from a measured width. A percentage inside `translateX` resolves against the
   * element's own box, so `calc(room - 100%)` is negative by exactly the overflow
   * and zero when there is none. Measuring instead would put the label at an
   * unclamped position for the one frame before the measurement landed, and a
   * test reading it in that frame would be right about the wrong thing.
   *
   * Vertically there is nothing to guard: it sits above the pointer by its own
   * height, and every page here has a header deeper than that.
   */
  function place(x) {
    const room = `calc(100vw - ${EDGE + GAP + x}px - 100%)`
    return `translateX(clamp(${EDGE - GAP - x}px, ${room}, 0px)) translateY(-100%)`
  }
</script>

{#if tip.shown}
  <!-- Inert while it follows a pointer, so it can never sit between the cursor
       and the thing it describes; tappable once pinned, or a tap meant to
       dismiss it would fall through onto the target underneath and pin it all
       over again. -->
  <div
    data-span-tip
    class="fixed z-50 max-w-64 rounded-md bg-paper px-3 py-2 text-xs leading-snug
           text-ink shadow-lg {tip.pinned ? 'pointer-events-auto' : 'pointer-events-none'}"
    style:left="{tip.shown.x + GAP}px"
    style:top="{tip.shown.y - GAP}px"
    style:transform={place(tip.shown.x)}
  >
    <span class="block font-semibold">{tip.shown.name}</span>
    <span class="block text-ink/70">{tip.shown.detail}</span>
  </div>
{/if}
