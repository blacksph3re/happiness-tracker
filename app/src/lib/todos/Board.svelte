<script>
  import Column from './Column.svelte'
  import { swipe } from '../swipe.js'
  import { tall, wide } from '../media.js'

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
   * **Below 48rem a column is a page, not a squeeze.** A switcher of equal
   * cells names every column with its count, exactly one column is on screen,
   * and a swipe or a tap on a cell moves between them. A two-column picture does not fit a phone,
   * and the answer is not to draw it narrower — it is to draw one of them. The
   * column itself is the same markup either way, so there is one card, one
   * quick-add and one drop handler rather than two of each.
   *
   * Carrying a card between pages is the other half: held against the left or
   * right **screen** edge, the pager turns with the card still in hand, and a
   * switcher cell is itself a drop target that lands a card at the end of its
   * column. That is TickTick's model, and it keeps positional placement on the
   * device where the picture cannot fit.
   */
  let {
    /** Which grouping is drawn, which decides how the phone's switcher lays out. */
    grouping = null,
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

  /**
   * The arrangement actually drawn, which a single column overrules on a phone.
   *
   * **One column is never a pager.** A switcher of one cell names the only
   * thing on screen, and a `columns` layout of one column would be a column
   * scrolling its own cards inside a page that already scrolls — so below
   * 48rem a board of one column is stacked whatever layout is remembered. That
   * is Plain always (it has one column by definition) and the archive under a
   * remembered column layout, which drew a one-cell switcher on a phone.
   */
  const arrangement = $derived(!$wide && columns.length <= 1 ? 'stacked' : layout)

  const paging = $derived(arrangement !== 'stacked' && !$wide)

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

  /**
   * How tall every pager column's heading row is kept, or null off the pager.
   *
   * The pager draws one column at a time in one place, so a column with a hint
   * or a heading button above its cards and one without put the first card at
   * two heights — measured 34.5px apart on Date, 24.5 on Size. The reserve is
   * the **grouping's** tallest row and not a button's always: every Kanban
   * column has a hint and none a button, and a button's height there cost 10px
   * of the phone's budget for nothing. Decided from the same inputs `Column`
   * decides `canClear` and `canSweep` from.
   *
   * @type {'button' | 'line' | null}
   */
  const head = $derived.by(() => {
    if (!paging) return null
    const buttons = columns.some(
      (one) => !one.readonly && (Boolean(oncleanup) || Boolean(onsweep && one.sweepTo))
    )
    if (buttons) return 'button'
    return columns.some((one) => one.hint) ? 'line' : null
  })

  /** The class the columns sit in, per arrangement. */
  const frame = $derived(
    paging
      ? 'flex flex-col'
      : arrangement === 'quadrants'
        ? 'grid grid-cols-2 gap-4'
        : arrangement === 'columns'
          ? 'flex gap-6 overflow-x-auto pb-2'
          : 'flex flex-col gap-8'
  )

  /**
   * Whether a column fills its height and scrolls its own cards.
   *
   * Only where columns sit beside each other **and** the window has the height
   * for a box worth scrolling. On a phone the page already scrolls, so a column
   * never becomes a second scroll box with a fade over cards: the pager is one
   * column in the page, and a phone on its side (past 48rem, short of 30rem
   * tall) keeps every card in the page too. The end-of-column spacer follows
   * this flag, so it never appears in a column that does not scroll.
   */
  const filled = $derived(!paging && arrangement !== 'stacked' && $tall)

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
  const celled = $derived(!paging && arrangement === 'quadrants')

  /**
   * How the column switcher's cells are laid out below 48rem, per grouping.
   *
   * **Equal cells sized to the screen, never a strip that scrolls.** The strip
   * showed one Eisenhower tab and part of the next at 390, with the rest off
   * screen behind a fade. A cell is its label over its count, so only the
   * label's width decides whether a row of them fits — measured at 320, where
   * a row has 296px: Kanban's widest label is *Backlog* and Date's *Tomorrow*,
   * and a quarter cell there left 61px — which *Tomorrow* filled to 60 in this
   * machine's monospace and overran in a phone's, splitting as "TOMORRO / W".
   * Both stay **one row of four**, because two by two cost 51px of a 320px
   * phone against the budget `todos-mobile.spec.js` keeps; below 24rem the
   * cell gives the label its padding back and the label draws at 0.02em
   * tracking rather than the meta's 0.08em, which leaves the word 15% to
   * spare; Size's *No
   * duration* is not inside a fifth and is inside a third by 3px, so it is
   * **three columns** — its label wraps rather than clips if a font runs wider
   * — (and five from
   * `sm`, where the pager still is and a fifth has room); Eisenhower is **two
   * by two** because that is the matrix; the Lists grouping has as many cells
   * as lists and **wraps** them. Literal strings, because a class assembled at
   * runtime generates no CSS.
   */
  const CELLS = {
    date: 'grid-cols-4',
    board: 'grid-cols-4',
    size: 'grid-cols-3 sm:grid-cols-5',
    matrix: 'grid-cols-2',
    list: 'grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]',
  }

  /** The switcher's grid. Never one cell: a single column is not paged at all. */
  const cells = $derived(CELLS[grouping] ?? CELLS.list)
</script>

{#if paging}
  <!-- A real tablist: one tab per column, named and counted, because a count is
       what tells you a column off screen has something in it. `data-drop-end`
       is the drop half — a tab names a column without naming a place inside it,
       so it resolves to the end of that column. A grid rather than a strip, so
       every category is on screen at once; `auto-rows-fr` keeps every cell one
       height, because equal padding does not make equal buttons. -->
  <div
    role="tablist"
    aria-label="Columns"
    data-pager-tabs
    class="mb-4 grid auto-rows-fr gap-1 {cells}"
  >
    {#each columns as column, index (column.id)}
      <button
        role="tab"
        id={`todo-tab-${column.id}`}
        data-tab={column.id}
        data-drop-end={drag?.dragging ? column.id : undefined}
        data-tab-target={drag?.dragging && drag.overTab === column.id ? '' : undefined}
        aria-selected={index === at}
        tabindex={index === at ? 0 : -1}
        class="meta flex min-h-11 min-w-0 flex-col items-center justify-center rounded-md
               border px-0.5 py-1.5 transition min-[24rem]:px-1
               {index === at
          ? 'border-ember bg-ember/10 text-paper'
          : 'border-white/15 hover:border-white/40'}
               {drag?.dragging && drag.overTab === column.id ? 'ring-2 ring-ember' : ''}"
        onclick={() => (visible = index)}
      >
        <!-- Wraps between words to a second line rather than losing letters, and
             **never inside a word**: `break-words` split *Tomorrow* at 320 on a
             phone. Two lines at most, so a long list name is still cut after
             that. -->
        <span
          class="line-clamp-2 max-w-full text-center [overflow-wrap:normal]
                 max-[24rem]:tracking-[0.02em]"
          data-tab-label
        >
          {column.label}
        </span>
        <span class="numeral" data-tab-count={column.id}>{column.tasks.length}</span>
      </button>
    {/each}
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
  <!-- A quiet column draws no title of its own: Plain's one column is called
       *Tasks* under a page heading called *Tasks*, which is the same sentence
       twice — and it made `getByRole('heading', { name: 'Tasks' })` name two
       elements. The label still names the quick-add and the keyboard's
       announcement, where it is not restating anything. -->
  {#each onScreen as column (column.id)}
    <!-- `min-w-52` and not wider: five columns at a 224px floor plus four
         24px gaps came to 1216px, which no desktop width could show — the row
         was clipped identically at 1280, 1440 and 1920. The page gives the
         board the width the screen has now; this is what decides how narrow a
         column may get before the row scrolls instead. -->
    <div
      data-quadrant={celled ? column.id : undefined}
      class="{paging || arrangement === 'stacked' ? '' : 'flex min-w-52 flex-1 basis-0'}
             {celled ? 'rounded-xl border border-white/10 bg-ink-soft/25 p-4' : ''}
             {stowed?.id === column.id
        ? 'pointer-events-none absolute top-0 left-[-9999px] w-80'
        : ''}"
    >
      <Column
        {column}
        titled={!paging && !column.quiet}
        steady={head}
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
