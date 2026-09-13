<script>
  import Column from './Column.svelte'
  import { swipe } from '../swipe.js'
  import { wide } from '../media.js'

  /**
   * The columns of a grouping, arranged.
   *
   * Six of the seven views in the brief are this component: what differs
   * between them is which columns tasks fall into and what a drop does, and
   * both of those are a grouping module rather than markup. So this file knows
   * nothing about dates, priorities or lists — it draws columns, and a column
   * is `{id, label, hint, tasks}`.
   *
   * Four arrangements of **one** `Column`, which is the point of taking the
   * columns as data:
   *
   * | | |
   * | --- | --- |
   * | `stacked` | One under the next, at every width. A stack already fits a phone |
   * | `columns` | A row of equal-width columns, each scrolling its own cards |
   * | `quadrants` | A 2×2 grid, which is what Eisenhower is |
   * | the pager | What `columns` and `quadrants` become below 48rem |
   *
   * **Below 48rem a column is a page, not a squeeze.** A tab strip names every
   * column with its count, exactly one column is on screen, and a swipe or a
   * tap on a tab moves between them. A two-column picture does not fit a phone,
   * and the answer is not to draw it narrower — it is to draw one of them. The
   * column itself is the same markup either way, so there is one card, one
   * quick-add and one drop handler rather than two of each.
   *
   * Carrying a card between pages is the other half: held against the left or
   * right **screen** edge, the pager turns with the card still in hand, and the
   * tab strip is itself a drop target that lands a card at the end of its
   * column. That is TickTick's model, and it keeps positional placement on the
   * device where the picture cannot fit.
   */
  let {
    columns,
    today,
    /** The lists a `#tag` in a quick-add may name. */
    lists = [],
    listsById = {},
    /** The list a typed task is created into, where that is worth saying. */
    into = null,
    showList = false,
    /** The signed-in username, passed to every card. */
    me = null,
    readOnly = false,
    /** `stacked`, `columns` or `quadrants`. The pager is what the last two become. */
    layout = 'stacked',
    drag = null,
    /** The task menu the cards may open. Passed through to every column. */
    menu = null,
    onadd = () => {},
    ontoggle = () => {},
    onopen = () => {},
    onnudge = () => {},
    oncleanup = null,
    /** Move a column's open tasks to the column it names. See `Column`. */
    onsweep = null,
    /** Read the page after the one held, for whichever column is `paged`. */
    onolder = null,
    /** Whether that read is out. Passed to every column; only a paged one draws it. */
    loadingOlder = false,
  } = $props()

  /**
   * Which column is on screen in the pager.
   *
   * Component state and deliberately **not** remembered: which page you were
   * looking at is a fact about one glance at one screen, not a preference, and
   * an account that opened the board on *Backlog* because a phone was last left
   * there would be answering a question nobody asked. The grouping and the
   * layout *are* remembered, because those are choices.
   */
  let visible = $state(0)

  const paging = $derived(layout !== 'stacked' && !$wide)

  /** Clamped rather than reset, so a column disappearing does not blank the page. */
  const at = $derived(Math.min(visible, Math.max(columns.length - 1, 0)))

  const shown = $derived(columns[at] ?? null)

  /** The `client_id` of the card in hand, or null. */
  const carrying = $derived(drag?.dragging ?? null)

  /** The column that card came out of, while it is still listed there. */
  const source = $derived(
    carrying
      ? (columns.find((one) => one.tasks.some((task) => task.client_id === carrying)) ?? null)
      : null
  )

  /**
   * The carried card's own column, kept mounted while the pager shows another.
   *
   * **The card follows the pointer across a page turn, and this is what lets
   * it.** The carried card is the *real* card — one element, one set of
   * handlers — drawn `position: fixed` where the pointer is; it lives in its
   * column's markup, and the pager draws one column. So turning the page while
   * carrying would unmount the very element in hand: the card would vanish
   * mid-gesture, and the press that is holding it would lose the node its
   * pointer capture and its `touchmove` guard are attached to.
   *
   * Kept in the same keyed `{#each}` as the column on screen rather than drawn
   * a second time, which is the whole point: Svelte *moves* an element whose
   * key it still sees and destroys one it does not, so the card is never
   * re-created and there is still exactly one of it. It is stowed off-screen
   * with `pointer-events: none`, so `elementFromPoint` cannot resolve a drop
   * into a column nobody can see — and being out of flow, it costs the page
   * neither height nor a sideways scroll.
   */
  const stowed = $derived(
    paging && source && shown && source.id !== shown.id ? source : null
  )

  /** The columns with markup on the page, in the order they are written. */
  const onScreen = $derived(paging ? [shown, stowed].filter(Boolean) : columns)

  /**
   * Turn the pager, from a swipe, a tab or a card held at the edge.
   *
   * @param {number} delta `1` towards the later columns, `-1` back.
   */
  function turn(delta) {
    visible = Math.min(Math.max(at + delta, 0), columns.length - 1)
  }

  /**
   * Read a swipe, unless it was really a card being put down.
   *
   * `pointerup` arrives before `touchend`, so by the time a swipe is decided
   * the drag has already reset — and carrying a card to the right-hand edge
   * satisfies every condition a swipe has. `justDropped` is what tells the two
   * apart; without it every drop near an edge also turned the page.
   *
   * @param {number} delta
   */
  function onSwipe(delta) {
    if (!paging) return
    if (drag?.dragging || drag?.justDropped) return
    turn(delta)
  }

  // Assigning a callback, not deriving state: `edge` inside the drag is a plain
  // closure variable, so this effect writes nothing anything reads and cannot
  // re-trigger itself. Cleared when the pager is not the arrangement, which is
  // what stops a drag on a wide screen turning a page that is not drawn.
  $effect(() => {
    if (!drag) return
    drag.onEdge = paging ? turn : null
    return () => {
      drag.onEdge = null
    }
  })

  /** The class the columns sit in, per arrangement. */
  const frame = $derived(
    paging
      ? 'flex flex-col'
      : layout === 'quadrants'
        ? 'grid grid-cols-2 gap-4'
        : layout === 'columns'
          ? 'flex gap-6 overflow-x-auto pb-2'
          : 'flex flex-col gap-8'
  )

  /** Whether a column fills its height and scrolls its own cards. */
  const filled = $derived(!paging && layout !== 'stacked')

  /**
   * Whether the four columns are being drawn as a matrix rather than as a row.
   *
   * A quadrant gets a **cell**: a boundary of its own, because four bare
   * headings in a 2×2 grid read as four unrelated columns — and because the
   * grid row takes the taller quadrant's height, so a four-card quadrant sat
   * over 330px of blank page that read as a layout fault rather than as an
   * empty half of a matrix. The border is what makes that emptiness legible,
   * which is why the heights stay equal instead of being let go ragged.
   */
  const celled = $derived(!paging && layout === 'quadrants')

  /**
   * The tab strip, and whether it is showing all of itself.
   *
   * At 390px the Eisenhower strip was one tab and half of the next, with two
   * off-screen and nothing — no arrow, dot or fade — saying so. Read from the
   * element rather than from the column count, because whether four labels fit
   * depends on the labels.
   */
  let strip = $state(null)
  let edges = $state({ start: false, end: false })

  function measureEdges() {
    if (!strip) {
      edges = { start: false, end: false }
      return
    }
    const room = strip.scrollWidth - strip.clientWidth
    edges = { start: strip.scrollLeft > 2, end: room > 2 && strip.scrollLeft < room - 2 }
  }

  // Reads the columns and the arrangement and writes only `edges`, which
  // neither is derived from. A resize changes `clientWidth` with no scroll and
  // no re-render, so the listener is the other half.
  $effect(() => {
    columns.length
    paging
    measureEdges()
    globalThis.addEventListener('resize', measureEdges)
    return () => globalThis.removeEventListener('resize', measureEdges)
  })
</script>

{#if paging}
  <!-- A real tablist: one tab per column, named and counted, because a count is
       what tells you a column off screen has something in it. `data-drop-end`
       is the drop half — a tab names a column without naming a place inside it,
       so it resolves to the end of that column. -->
  <div class="relative -mx-5 mb-4">
  <div
    role="tablist"
    aria-label="Columns"
    data-pager-tabs
    bind:this={strip}
    onscroll={measureEdges}
    class="flex items-stretch gap-1 overflow-x-auto px-5 pb-1"
  >
    {#each columns as column, index (column.id)}
      <button
        role="tab"
        id={`todo-tab-${column.id}`}
        data-tab={column.id}
        data-drop-end={drag?.dragging ? column.id : undefined}
        aria-selected={index === at}
        tabindex={index === at ? 0 : -1}
        class="meta flex shrink-0 items-center gap-2 rounded-md border px-3 py-2
               whitespace-nowrap transition
               {index === at
          ? 'border-ember bg-ember/10 text-paper'
          : 'border-white/15 hover:border-white/40'}"
        onclick={() => (visible = index)}
      >
        {column.label}
        <span class="numeral" data-tab-count={column.id}>{column.tasks.length}</span>
      </button>
    {/each}
  </div>
    <!-- What says there is more strip than screen, and which way. Drawn only
         when there is something off-screen in that direction, or a marker that
         is always on says nothing. `pointer-events: none`, so it never eats a
         tap aimed at the tab beneath it — a tab is also a drop target. -->
    {#if edges.start}
      <div
        data-tabs-more="start"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 left-0 w-8"
        style="background-image: linear-gradient(to right, var(--color-ink), transparent)"
      ></div>
    {/if}
    {#if edges.end}
      <div
        data-tabs-more="end"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 right-0 w-8"
        style="background-image: linear-gradient(to left, var(--color-ink), transparent)"
      ></div>
    {/if}
  </div>
{/if}

<!-- The swipe sits on the body rather than the whole page, so it cannot fight
     the tab strip's own horizontal scroll. It is always an enhancement: the
     tabs above do the same thing, which is why this element is exempt from
     `a11y_no_static_element_interactions` rather than given a role it could not
     honour. -->
<div
  data-board
  class={frame}
  use:swipe={{ onswipe: onSwipe }}
  role={paging ? 'tabpanel' : undefined}
  aria-labelledby={paging && shown ? `todo-tab-${shown.id}` : undefined}
>
  {#each onScreen as column (column.id)}
    <!-- `min-w-52` and not wider: five columns at a 224px floor plus four
         24px gaps came to 1216px, which no desktop width could show — the row
         was clipped identically at 1280, 1440 and 1920. The page gives the
         board the width the screen has now; this is what decides how narrow a
         column may get before the row scrolls instead. -->
    <div
      data-quadrant={celled ? column.id : undefined}
      class="{paging || layout === 'stacked' ? '' : 'flex min-w-52 flex-1 basis-0'}
             {celled ? 'rounded-xl border border-white/10 bg-ink-soft/25 p-4' : ''}
             {stowed?.id === column.id
        ? 'pointer-events-none absolute top-0 left-[-9999px] w-80'
        : ''}"
    >
      <Column
        {column}
        titled={!paging}
        {today}
        {lists}
        {listsById}
        {into}
        {showList}
        {me}
        {readOnly}
        {drag}
        {menu}
        liftable={!readOnly}
        {filled}
        {onadd}
        {ontoggle}
        {onopen}
        {onnudge}
        {oncleanup}
        {onsweep}
        {onolder}
        {loadingOlder}
      />
    </div>
  {/each}
</div>
