<script>
  /**
   * The one frame every page draws inside, in every half.
   *
   * **Fixed by the window, never by the view.** At any window size every page
   * draws inside one box: the whole window less the gutter, capped at
   * `max-w-frame` (125rem, which is what the todo half's Size grouping in five
   * columns measured as needing — the reasoning is beside the token in
   * `app.css`), centred. What a page draws decides how much of the frame it
   * fills, and never where the frame is.
   *
   * **A half centres one column, and every page of the half fills it.**
   * `column` is a `max-w-*` class spelled once per zone in `lib/<zone>/column.js`,
   * and a page carries no width of its own, so every tab of the half is one width
   * at one x: the heading holds still and each tab sits truly centred on a wide
   * screen. Three earlier shapes each cost something: every page centring its
   * own `max-w-*` moved Time's heading 128px between its tabs at 1280, every page
   * anchored at the frame's left edge pressed the whole app against the left of
   * a wide screen, and narrow pages starting at a wide column's left edge put
   * Track 256px right of true centre.
   * The landing page, Settings and People are tabs of nothing and pass their own
   * width. Centred only from `md`, so nothing changes on a phone.
   *
   * **A board of several columns breaks out of the column, and nothing else
   * does.** `board` is drawn under the column: in a box of the column's own
   * width and centring while it is one column, and across the whole frame from
   * its left edge when `spread`. The todo half uses it — its heading and toolbar
   * sit in the column on every page, a stack or the calendar's Day fills the
   * column, and a column board or the calendar's Week fills the frame. A sibling
   * of the column rather than a negative margin inside it, because a margin
   * would need the frame's width in CSS, and the only exact way to have that
   * (`container-type`) makes the frame the containing block of every `fixed`
   * descendant — the carried card among them. And the same box whichever way it
   * is drawn, so switching a layout changes a class and never remounts the board
   * a drag or a focused card lives in.
   *
   * **The header shares the frame, not the column.** `App.svelte` caps its nav at
   * the same token with the same gutter, so the logo sits at the frame's left
   * edge on every page — over the todo half's heading, and left of a centred
   * column.
   *
   * **The gutter is `--gutter`, set once in `app.css`**: 12px on a phone, where
   * six 44px colour swatches on the Lists page need the room at 320, and 20px
   * from `sm`. A custom property rather than a padding class because a row that
   * bleeds to the screen edge uses the same number
   * (`-mx-(--gutter) px-(--gutter)`), and two spellings of one number is how a
   * page came to sit 8px left of the others.
   *
   * **A page may hand the heading over.** The todo pages pass `eyebrow` and
   * `title`, because Lists wrote `mb-8` where the other two wrote `mb-6` and
   * that was an 8px jump on every walk between them; `aside` is drawn beside the
   * title on its line, where Tasks puts *Clean up N done*. A heading handed over
   * with a `column` is drawn inside that column, so it holds still wherever the
   * board beneath it is drawn. Pages elsewhere keep their own heading inside
   * their own reading column and pass neither.
   */
  let {
    eyebrow = null,
    title = null,
    aside = null,
    column = null,
    board = null,
    spread = false,
    children,
  } = $props()
</script>

{#snippet heading()}
  {#if title}
    <div class="mb-6" data-frame-heading>
      <p class="meta">{eyebrow}</p>
      <div class="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 class="text-3xl font-bold tracking-tight">{title}</h1>
        {@render aside?.()}
      </div>
    </div>
  {/if}
{/snippet}

<div class="px-(--gutter) py-8">
  <div data-frame class="mx-auto w-full max-w-frame">
    {#if column}
      <div data-frame-column class="w-full md:mx-auto {column}">
        {@render heading()}
        {@render children()}
      </div>
      {#if board}
        <div data-frame-board class="w-full {spread ? '' : `md:mx-auto ${column}`}">
          {@render board()}
        </div>
      {/if}
    {:else}
      {@render heading()}
      {@render children()}
    {/if}
  </div>
</div>
