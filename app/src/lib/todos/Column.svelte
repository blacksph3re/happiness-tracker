<script>
  import QuickAdd from './QuickAdd.svelte'
  import TaskCard from './TaskCard.svelte'

  /**
   * One column of the board, in whichever arrangement is around it.
   *
   * Extracted because the phone's pager draws the *same* column the wide
   * layouts do — one card, one quick-add, one drop handler, one insertion gap
   * — and two copies of that would be two places for a tap to stop working on
   * a phone and nowhere else. Three arrangements, one component: `Board`
   * decides whether the columns are stacked, in a row, in a 2×2 grid or one at
   * a time, and none of that reaches in here.
   *
   * The component knows nothing about dates, priorities or lists. A column is
   * `{id, label, hint, tasks, date?, readonly?, paged?, sweepTo?, archiveOwner?}`
   * and that is the whole contract.
   */
  let {
    column,
    today,
    /** The lists a `#tag` in this column's quick-add may name. */
    lists = [],
    listsById = {},
    /** The list a typed task is created into, where that is worth saying. */
    into = null,
    showList = false,
    /** The signed-in username, for a card to say whose list somebody else's is. */
    me = null,
    /** Whether ticking is offered. The archive chip's view says no. */
    readOnly = false,
    drag = null,
    /**
     * The task menu the cards may open, or null where none is offered.
     *
     * Passed straight through and withheld from a frozen column: the three
     * verbs are all about a live task, and an archived one is neither given up
     * on nor sent anywhere but back.
     */
    menu = null,
    /** Whether this column's cards can be lifted at all. */
    liftable = false,
    /**
     * Whether the column scrolls its own cards rather than the page.
     *
     * True in the `columns` and `quadrants` arrangements, where the point is
     * that every column is comparable at a glance and a long one must not push
     * the others off the bottom. False when stacked or paged, where the page's
     * own scroll is the right one.
     */
    filled = false,
    /**
     * Whether the column draws its own name and count.
     *
     * False on the pager, where the tab above it already says both: `PAST 3`
     * on the tab and `Past 3` as a heading 30px under it is the same
     * sentence twice, and the plan puts the counts on the tabs. The `hint` is
     * not repeated up there and stays either way.
     */
    titled = true,
    onadd = () => {},
    ontoggle = () => {},
    onopen = () => {},
    /** Move a card with the keyboard: one step along, or one column across. */
    onnudge = () => {},
    /** Archive every done task in *this* column, where that is on offer. */
    oncleanup = null,
    /**
     * Move every open task in this column to the column it names, where the
     * column names one (`sweepTo`, which the route fills in from the
     * grouping's `sweep`). The move itself is the route's: this only asks.
     */
    onsweep = null,
    /**
     * Read the page after the one held, for a column that is `paged`.
     *
     * The archive is the one collection read a page at a time, but nothing in
     * here knows that: a column says it is a page of something longer and the
     * route says what reading more of it means.
     */
    onolder = null,
    /**
     * Whether that read is out.
     *
     * The request's own state and nothing else: the rows on screen come from
     * the store and are never waiting on it, which is the difference between
     * this and a `loading` flag cleared in a `finally`.
     */
    loadingOlder = false,
  } = $props()

  /** A task arrives in a read-only column by being finished, never by being placed. */
  const frozen = $derived(Boolean(column.readonly))

  const carrying = $derived(drag?.dragging ?? null)

  /** Whether the card in hand would land in this column. */
  const over = $derived(Boolean(carrying) && drag.overColumn === column.id && !frozen)

  /**
   * How far the displaced cards move, which is the carried card's own height.
   *
   * Plus the flex gap, so the space that opens is the one the card will occupy
   * rather than one card's worth of it with the gaps swallowed.
   */
  const gap = $derived(over ? (drag.height || 0) + 8 : 0)

  /**
   * Whether the end of this column holds the carried card's height open.
   *
   * **What makes the last slot reachable by pointer**, in a column that scrolls
   * its own cards. The gap is a transform, and a transformed box counts towards
   * scrollable overflow, so without this the column's maximum depended on where
   * the gap was: 824 with the gap above the last card, 766 with it at the end.
   * Scrolled far enough to read the end slot, the gap closed, the maximum fell,
   * and the browser clamped the pointer back above the last card — so the end
   * slot could be neither shown nor dropped into. Reserved in the flow, the
   * space a displaced last card is pushed into is always already there, and the
   * maximum is one number wherever the gap is.
   *
   * Only while the card is **over** this column, and only in a column that is
   * its own scroll box. The source column is not a special case: its slot holds
   * the card's place, which keeps its height from depending on the carry, and
   * when the pointer is over it the gap and this come with `over` as they do
   * anywhere. Stacked and on the pager the page scrolls, and nothing measures a
   * maximum — space added in the flow there is only the quick-add and every
   * column below jumping by a card.
   */
  const reserving = $derived(over && filled)

  /**
   * The cards, each knowing whether it is the one in hand and whether the gap
   * has pushed it down.
   *
   * Counted over the cards the drop index was measured over, which excludes the
   * one being carried — see `dropIndex`. Built as one pass rather than by
   * splicing a marker in, which is what phase 2 did and what produced two
   * `{#each}` items under one key: the carried card does not advance the count,
   * so two rows in a row matched the index, and Svelte's duplicate-key error
   * silently stopped that one column updating for the rest of the session.
   */
  const rows = $derived.by(() => {
    let seen = 0
    return column.tasks.map((task) => {
      const carried = task.client_id === carrying
      const displaced = over && !carried && seen >= drag.index
      if (!carried) seen += 1
      return { task, carried, displaced }
    })
  })

  /** How many done tasks this column holds, for the button that clears them. */
  const done = $derived(column.tasks.filter((one) => one.done_at).length)

  /** Whether this column's own cleanup is on offer, which the header row holds. */
  const clearable = $derived(Boolean(oncleanup) && done > 0 && !frozen)

  /** Whether asking has been asked. Per column, so two cannot be armed at once. */
  let confirming = $state(false)

  /**
   * How many tasks a sweep would move: the **open** ones. A done task planned
   * in the past was done then, and moving its plan would rewrite that.
   */
  const open = $derived(column.tasks.filter((one) => !one.done_at).length)

  /** Whether this column's sweep is on offer. Not at zero: a button moving nothing. */
  const sweepable = $derived(Boolean(onsweep && column.sweepTo) && open > 0 && !frozen)

  /**
   * What the sweep asks, as one string. Composed here rather than in markup,
   * where an `{#if}` beside a `?` swallowed the space between two sentences.
   */
  const question = $derived(
    column.sweepTo
      ? `Move ${open} ${column.label.toLowerCase()} ${open === 1 ? 'task' : 'tasks'} to ${
          column.sweepTo.label
        }?${column.sweepTo.date ? ` They will be planned for ${column.sweepTo.date}.` : ''}`
      : ''
  )

  /** Whether the sweep has asked its question, armed per column like cleanup. */
  let sweeping = $state(false)

  // Disarmed whenever the count moves, the rule the toolbar's cleanup follows:
  // a question armed against three tasks must not be answered about a fourth
  // that arrived from another device in between. Reads `open`, writes only
  // `sweeping`, which nothing here derives `open` from.
  $effect(() => {
    open
    sweeping = false
  })

  /**
   * The quick-add's own name for this column, which is the gesture and not the
   * heading: typing into *Done* creates a task already ticked, and `Add to
   * done…` read as a control pointed at the wrong place. See `adds` on the
   * column contract.
   */
  const adding = $derived(column.adds ? { ...column, label: column.adds } : column)

  /** The scrolling box, where the column keeps its own cards rather than the page. */
  let list = $state(null)

  /**
   * Whether there are cards below the fold of that box.
   *
   * A `60vh` window over forty-nine cards showed eight of them with **nothing**
   * saying so: the overlay scrollbar is zero-width, so `clientWidth` and
   * `offsetWidth` both read 260 and the cut was invisible. A fade is what says
   * the column continues — chosen over a *showing 8 of 49* caption because
   * every one of the 49 is really there and scrollable, so a count of what
   * happens to be inside the viewport would be a measurement of the window
   * dressed as a fact about the data, and the heading already says 49.
   */
  let more = $state(false)

  function measure() {
    if (!list) {
      more = false
      return
    }
    more = list.scrollHeight - list.scrollTop - list.clientHeight > 4
  }

  // Reads the rows and the arrangement, writes only `more`, which neither of
  // them is derived from — so there is nothing here to feed back.
  $effect(() => {
    rows.length
    filled
    measure()
  })

  /**
   * Read a key press on a card as a move, an open or a tick.
   *
   * The keyboard path is not an accessibility afterthought: it is the version
   * of this gesture that works, and the pointer drag is the enhancement over
   * it — the arrangement `swipe.js` documents. It is also the one context that
   * cannot name a drop point precisely, so a sideways move lands at the same
   * index in the next column, clamped to its length.
   *
   * @param {KeyboardEvent} event
   * @param {object} task
   */
  function onKey(event, task) {
    // The keyboard's way into the menu, and it comes first: the pointer
    // gestures are the enhancement over this one, not the other way round.
    if (menu && menu.fromKey(event, task)) return
    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }
    const move = moves[event.key]
    if (move) {
      // Or the page scrolls under the card that is being moved, which is the
      // same reason the pointer drag prevents `touchmove`.
      event.preventDefault()
      onnudge(task, column.id, move[0], move[1])
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      onopen(task)
      return
    }
    if (event.key === ' ' && !readOnly && !frozen) {
      event.preventDefault()
      ontoggle(task)
    }
  }
</script>

<!-- `data-column` is what `elementFromPoint` resolves a drop onto, so the
     attribute is the drop target rather than a handler being attached to every
     card position. `data-drop-index` is the state the gap is a picture of, and
     the thing tests read: a computed style sampled mid-transition is an
     interpolated value. -->
<section
  data-column={column.id}
  data-drop-index={over ? drag.index : undefined}
  class="flex w-full min-w-0 flex-col gap-2"
>
  {#if titled || column.hint || clearable || sweepable}
    <!-- Wraps, so a question that names an owner's archive or a date can take
         a second line in a narrow column rather than pushing the row past it. -->
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {#if titled}
        <h2 class="text-sm font-semibold tracking-tight">{column.label}</h2>
        <span class="meta numeral" data-count={column.id}>{column.tasks.length}</span>
      {/if}
      {#if column.hint}
        <span class="meta" data-hint={column.id}>{column.hint}</span>
      {/if}
      {#if clearable}
        <!-- Behind the same two-step confirm the modal's Delete uses, and for
             the same reason: one press took six tasks off the board, where
             taking *one* task away asks first. The question replaces the
             button that raised it, and it names the count and where they go. -->
        {#if confirming}
          <span class="meta ml-auto whitespace-nowrap" data-cleanup-column-asking={column.id}>
            Archive {done} done?
          </span>
          {#if column.archiveOwner}
            <!-- The server sends a shared list's done tasks to its owner's
                 archive, so without this a member watches them vanish. -->
            <span class="meta" data-cleanup-column-elsewhere={column.id}>
              To {column.archiveOwner}’s archive.
            </span>
          {/if}
          <button
            class="meta rounded-md border border-ember px-2 py-1 whitespace-nowrap
                   text-paper transition hover:bg-ember/10"
            data-cleanup-column-confirm={column.id}
            onclick={() => {
              confirming = false
              oncleanup(column)
            }}
          >
            Archive
          </button>
          <button
            class="meta rounded-md border border-white/20 px-2 py-1 whitespace-nowrap
                   hover:border-white/40"
            data-cleanup-column-cancel={column.id}
            onclick={() => (confirming = false)}
          >
            Cancel
          </button>
        {:else}
          <button
            class="meta ml-auto rounded-md border border-white/15 px-2 py-1 whitespace-nowrap
                   hover:border-white/40"
            data-cleanup-column={column.id}
            onclick={() => (confirming = true)}
          >
            Clean up {done}
          </button>
        {/if}
      {/if}
      {#if sweepable}
        <!-- The same two-step confirm as cleanup, and it names the date rather
             than the column: *Later* in this grouping is the day after
             tomorrow, which skips two days somebody may have expected. -->
        {#if sweeping}
          <span class="meta ml-auto" data-sweep-asking={column.id}>{question}</span>
          <button
            class="meta rounded-md border border-ember px-2 py-1 whitespace-nowrap
                   text-paper transition hover:bg-ember/10"
            data-sweep-confirm={column.id}
            onclick={() => {
              sweeping = false
              onsweep(column)
            }}
          >
            Move
          </button>
          <button
            class="meta rounded-md border border-white/20 px-2 py-1 whitespace-nowrap
                   hover:border-white/40"
            data-sweep-cancel={column.id}
            onclick={() => (sweeping = false)}
          >
            Cancel
          </button>
        {:else}
          <button
            class="meta ml-auto rounded-md border border-white/15 px-2 py-1 whitespace-nowrap
                   hover:border-white/40"
            data-sweep={column.id}
            onclick={() => (sweeping = true)}
          >
            Move {open} to {column.sweepTo.label}
          </button>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- `relative` is load-bearing, not styling: it makes this the `offsetParent`
       of every card, which is what `columnGeometry` measures `offsetTop`
       against — and measuring layout rather than boxes is what lets the gap be
       a transform without moving the index it is drawn from. -->
  <!-- The wrapper exists for the fade, which has to sit *outside* the box it
       fades: an overlay inside a scrolling box scrolls away with the content.
       It is outside the `offsetParent` walk `columnGeometry` does, which ends
       at `[data-cards]`, so the drop index is untouched. -->
  <div class="relative">
    <div
      bind:this={list}
      data-cards
      onscroll={measure}
      class="relative flex flex-col gap-2 {filled ? 'max-h-[60vh] overflow-y-auto' : ''}"
    >
    {#each rows as row (row.task.client_id)}
      <!-- Two things about one wrapper. The **gap** is a transform, so the list
           never reflows: only one number changes as the pointer moves and
           nothing below is laid out again. `motion-safe` is where
           `prefers-reduced-motion` lands — it removes the *transition*, never
           the gap. The space is information; the movement is manners.

           The **height** is what holds the place of the card in hand, and it is
           the half that makes a travelling card safe rather than pretty: that
           card is `position: fixed` and so out of flow, and without this the
           column closes up under the pointer — every card below it moving, and
           the drop index measured against cards that shifted for a reason the
           index knows nothing about. The exact height rather than the rounded
           one the gap uses, or the cards below sit half a pixel out. -->
      <div
        class="motion-safe:transition-transform motion-safe:duration-150"
        data-displaced={row.displaced ? 'true' : undefined}
        style:transform={row.displaced ? `translateY(${gap}px)` : undefined}
        style:height={row.carried && drag?.originRect
          ? `${drag.originRect.height}px`
          : undefined}
      >
        <TaskCard
          task={row.task}
          {today}
          columnDate={column.date ?? null}
          {showList}
          {me}
          readOnly={readOnly || frozen}
          liftable={liftable && Boolean(drag)}
          menu={readOnly || frozen ? null : menu}
          list={listsById[row.task.list_id] ?? null}
          carried={row.carried}
          carry={drag}
          onstart={(event, task) => drag?.start(event, task)}
          onkey={onKey}
          {ontoggle}
          {onopen}
        />
      </div>
      {/each}

      <!-- The rest of the app names its emptiness — *Nothing tracked in this
           window.*, *No projects yet* — and four bare headings over four boxes
           said nothing at all about whether a column was empty or still
           loading. -->
      {#if !rows.length}
        <p class="meta" data-empty={column.id}>Nothing here yet</p>
      {/if}

      <!-- The carried card's height, plus the flex gap before it, is exactly the
           `gap` the displaced cards move by — so a displaced last card ends
           where this does. No `data-client-id`, so `columnGeometry` never counts
           it as a card or a slot. `shrink-0`, because an empty flex item in a
           height-capped column would otherwise be squeezed to nothing. -->
      {#if reserving}
        <div
          data-drop-spacer
          aria-hidden="true"
          class="shrink-0"
          style:height={`${drag.height || 0}px`}
        ></div>
      {/if}
    </div>

    <!-- What says the column continues. `aria-hidden`, because the count in the
         heading is the accessible form of the same fact. -->
    {#if more}
      <div
        data-column-more={column.id}
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-0 bottom-0 h-10"
        style="background-image: linear-gradient(to top, var(--color-ink), transparent)"
      ></div>
    {/if}
  </div>

  <!-- Drawn only while there is a cursor to follow, which the route decides:
       the end of a paged collection is said by the absence of a marker rather
       than by a count, so a page that comes back short is not the end and a
       page that fills exactly is not more. Disabled rather than replaced while
       the read is out, so the foot of the column does not move under a finger
       that has just tapped it. -->
  {#if column.paged && onolder}
    <button
      class="meta self-start rounded-md border border-white/15 px-3 py-2 whitespace-nowrap
             hover:border-white/40 disabled:border-white/10 disabled:text-haze"
      data-show-older={column.id}
      disabled={loadingOlder}
      aria-busy={loadingOlder ? 'true' : undefined}
      onclick={() => onolder(column)}
    >
      {loadingOlder ? 'Loading older…' : 'Show older'}
    </button>
  {/if}

  {#if !readOnly && !frozen}
    <!-- `adding` and not `column`: the box is named after what typing into it
         does, which for *Done* is not what the heading says. Everything else
         about the column — its id, its preset — is the same object. -->
    <QuickAdd column={adding} {today} {lists} {into} {onadd} />
  {/if}
</section>
