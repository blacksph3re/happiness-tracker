<script>
  /**
   * The one frame every todo page draws inside.
   *
   * **Fixed by the window, never by the view.** At any window size Tasks in every
   * grouping and layout, Calendar and Lists all start at one left edge and share
   * one width: the whole window less the gutter, capped at `max-w-todo-frame`
   * (125rem, which is what Size in five columns measured as needing — the
   * reasoning is beside the token in `app.css`), centred. What a page draws decides only how much of the frame it fills — a
   * column board fills it, a stack keeps its reading width and starts at the
   * left — and never where the frame is. It used to be the other way round: a
   * column layout drew full width, a stack centred a reading width and Lists
   * centred a narrower one, so the heading sat at three x positions and the
   * grouping pills moved by 409px between two taps.
   *
   * **The gutter belongs to the frame**, so no page picks its own: 12px on a
   * phone, where six 44px colour swatches on the Lists page need the room at
   * 320, and 20px from `sm`. It is a custom property rather than a padding class
   * because a row that bleeds to the screen edge uses the same number
   * (`-mx-(--gutter) px-(--gutter)`), and two spellings of one number is how a
   * page came to sit 8px left of the others.
   *
   * **So does the heading, and for the same reason.** Each page wrote its own
   * eyebrow, title and the space under them, and Lists wrote `mb-8` where the
   * other two wrote `mb-6` — so its first row sat 8px lower, a vertical jump on
   * every walk between pages, which is exactly what this component exists to
   * remove. The space is one value here now. `aside` is drawn beside the title
   * on its line: Tasks puts *Clean up N done* there, because a control a tick
   * calls up must sit in a row that exists anyway.
   */
  let { eyebrow, title, aside = null, children } = $props()
</script>

<div class="px-(--gutter) py-8 [--gutter:0.75rem] sm:[--gutter:1.25rem]">
  <section data-frame class="mx-auto w-full max-w-todo-frame">
    <div class="mb-6" data-frame-heading>
      <p class="meta">{eyebrow}</p>
      <div class="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 class="text-3xl font-bold tracking-tight">{title}</h1>
        {@render aside?.()}
      </div>
    </div>
    {@render children()}
  </section>
</div>
