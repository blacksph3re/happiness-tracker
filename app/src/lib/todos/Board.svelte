<script>
  import { untrack } from 'svelte'

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
   * The column a reader chose in the pager, per grouping.
   *
   * Component state and deliberately **not** remembered: which page you were
   * looking at is a fact about one glance at one screen, not a preference, and
   * an account that opened the board on *Backlog* because a phone was last left
   * there would be answering a question nobody asked. The grouping and the
   * layout *are* remembered, because those are choices. Keyed by grouping, and
   * every grouping keeps its own for the life of the page: holding one choice
   * at a time meant steering Eisenhower made Kanban forget where it was left,
   * so which column the pager came back to depended on which grouping had been
   * steered last. Opening a grouping never steered still lands afresh.
   *
   * @type {Record<string, number>}
   */
  let steered = $state({})

  /**
   * Where a grouping landed, latched the first time any of its columns held a task.
   *
   * **The pager opens on the first column that holds a task**, or on the first
   * column when none does. Measured before the rule at 390: seven of fifteen
   * openings across three ordinary boards landed on an empty page while a tab
   * beside it counted tasks — Date on *Past*, Kanban on *Done*, Eisenhower on
   * *Do first*. Latched rather than derived for ever, because a column the
   * reader is on emptying by their own hand — ticking its last task — must not
   * walk them to another page. Until something is latched the landing follows
   * the columns, so a board whose tasks arrive a round trip after it painted
   * still lands where they are. Keyed by grouping for the same reason as
   * `steered`.
   *
   * @type {Record<string, number>}
   */
  let landed = $state({})

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

  /**
   * The narrowest a column may be drawn beside others, and the gap between them.
   *
   * `min-w-40` below, in pixels. 160 and not the 208 it was: at 844×390 Kanban
   * needed 904px of an 804px board, so the row became a sideways-scrolling box
   * with Backlog cut 100px — and nothing in the todo half may need a sideways
   * scroll. At 160 four columns fit from 768 up.
   */
  const COLUMN_FLOOR = 160
  const COLUMN_GAP = 24

  /** The width the board is laid out in, measured; 0 before the first layout. */
  let room = $state(0)

  /**
   * Whether this grouping's columns fit side by side at the floor.
   *
   * Where they do not, the pager is drawn instead, at any width — Size's five
   * columns need 896px, which a 768 or 844 window does not have. Decided from
   * the frame's width, which the window fixes and the board's content cannot
   * change, so the pager appearing cannot feed back into this; and from 48rem
   * the scrollbar's room is always reserved, so a page growing taller does not
   * move it either. Unknown (0) reads as fitting, which is what the page drew
   * before this was measured.
   */
  const fits = $derived.by(() => {
    if (!room) return true
    const across = arrangement === 'quadrants' ? Math.min(columns.length, 2) : columns.length
    const gap = arrangement === 'quadrants' ? 16 : COLUMN_GAP
    return across * COLUMN_FLOOR + Math.max(across - 1, 0) * gap <= room
  })

  const paging = $derived(arrangement !== 'stacked' && (!$wide || !fits))

  /** The first column holding a task, or the first column. */
  const firstFull = $derived(Math.max(columns.findIndex((one) => one.tasks.length > 0), 0))

  /** Clamped rather than reset, so a column disappearing does not blank the page. */
  const at = $derived(
    Math.min(
      steered[grouping] ?? landed[grouping] ?? firstFull,
      Math.max(columns.length - 1, 0)
    )
  )

  // Latches the landing. Reads `landed` untracked, so the only thing it writes
  // is nothing it depends on: it re-runs when the columns or the grouping
  // change, and writes at most once per grouping opened.
  $effect(() => {
    const key = grouping
    const found = columns.findIndex((one) => one.tasks.length > 0)
    untrack(() => {
      if (found < 0 || landed[key] !== undefined) return
      landed = { ...landed, [key]: found }
    })
  })

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
   * Remember the column chosen in this grouping.
   *
   * @param {number} index
   */
  function steer(index) {
    steered = { ...steered, [grouping]: index }
  }

  /**
   * Turn the pager, from a swipe, a tab or a card held at the edge.
   *
   * @param {number} delta `1` towards the later columns, `-1` back.
   */
  function turn(delta) {
    steer(Math.min(Math.max(at + delta, 0), columns.length - 1))
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

<!-- Measures the width the board has, for `fits`. No box of its own: it is
     not positioned, so the stowed column's `absolute` still resolves where it
     did, and it adds nothing above or beside the tabs or the board. -->
<div bind:clientWidth={room}>
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
               border px-0.5 py-1.5 transition select-none [-webkit-touch-callout:none]
               min-[24rem]:px-1
               {index === at
          ? 'border-ember bg-ember/10 text-paper'
          : 'border-white/15 hover:border-white/40'}
               {drag?.dragging && drag.overTab === column.id ? 'ring-2 ring-ember' : ''}"
        onclick={() => steer(index)}
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
        <!-- Held invisible for a column that has not been read (the archive
             offline), so the tab keeps its height and claims no number. -->
        <span class="numeral {column.unread ? 'invisible' : ''}" data-tab-count={column.id}
          >{column.tasks.length}</span>
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
    <!-- `min-w-40`, which is `COLUMN_FLOOR`: the narrowest a column is drawn
         beside others. Where a grouping's columns do not fit at it, `fits`
         draws the pager instead, so the row never scrolls sideways. -->
    <div
      data-quadrant={celled ? column.id : undefined}
      class="{paging || arrangement === 'stacked' ? '' : 'flex min-w-40 flex-1 basis-0'}
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
</div>
