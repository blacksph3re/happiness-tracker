<script>
  import { estimateLabel } from '../clock.js'
  import { chipColour } from '../palette.js'
  import { PRIORITY_LABELS } from '../todo-settings.js'
  import { dueLabel, isOverdue, plannedLabel, stepCount, taskColour, wallClock } from './fields.js'
  import { justLanded, settleInto } from './settle.js'
  import { justTicked } from './tick.js'
  import TickMark from './TickMark.svelte'

  /**
   * One task, as every view of the board draws it.
   *
   * A card carries two actions and no more, which is all this codebase allows
   * in one tile: the tickbox ticks, the title opens the modal. Every chip is a
   * `<span>` — they say what is set, and nothing about them is a control.
   */
  let {
    task,
    today,
    /**
     * The single day this column *is*, or null when it is a set of days. A card
     * in *Today* does not draw its own date, because the heading above it
     * already says it — the same reason the record table dropped its weekday
     * column.
     */
    columnDate = null,
    list = null,
    showList = false,
    /**
     * The signed-in account's username, so a list somebody else owns can say
     * whose it is. Null until the account is known, which draws no mark at all
     * rather than guessing.
     */
    me = null,
    carried = false,
    /**
     * The drag this card may be in the hand of, or null where there is none.
     *
     * Read for `x`, `y`, `grabOffset` and `originRect` — and only while
     * `carried`, which is what keeps every *other* card in the column out of a
     * dependency on a value that changes on every pointer move.
     */
    carry = null,
    /** Whether the tickbox is offered. The archive says no. */
    readOnly = false,
    /**
     * The task menu this card may open, or null where none is offered.
     *
     * The machine rather than a callback, as `carry` is: opening it takes a
     * right-click, a long press and two keys, and each of those is a rule the
     * machine owns rather than the card. Null in a read-only column — every
     * verb in it is about a live task, and an archived one is neither given up
     * on nor sent anywhere but back.
     */
    menu = null,
    /**
     * Whether the card can be picked up by a pointer.
     *
     * Separate from `readOnly` because the archive needs one without the
     * other: nothing can be dropped *into* it or ticked in it, and a task can
     * still be dragged *out* of it — which is the restore, and the second
     * thing the system lists being real rows bought over a flag.
     */
    liftable = false,
    ontoggle = () => {},
    onopen = () => {},
    onstart = () => {},
    /** A key pressed while the card itself has the focus. */
    onkey = () => {},
  } = $props()

  const done = $derived(Boolean(task.done_at))

  /**
   * Whether this rendering of the tick is the tick being made.
   *
   * Only a tick made on this device a moment ago draws itself in: a card that
   * arrives done — a board opened on finished tasks, a card mounted again later
   * — is drawn finished, and unticking is instant. The stamp is taken by the
   * gesture and read here, which is what lets a tick that moves the card into
   * another column still draw on arrival. See `tick.js`.
   *
   * The drawing is a CSS animation on the path and the strike, never a
   * transition on the card: a carried card sets `transition-none` and a settle
   * moves the card itself, and neither reaches inside it.
   */
  const drawing = $derived(done && justTicked(task.client_id))

  /**
   * Whether a due date has passed — the one thing on a card drawn in red.
   *
   * **Due, never planned.** A plan for a day that has gone is *past*, which is
   * what its column says; only a deadline can be missed. A task due today is
   * due rather than late. The rule is `isOverdue`, which the landing card's
   * count reads too, so the word cannot mean two things a tap apart.
   */
  const overdue = $derived(isOverdue(task, today))

  /**
   * Whether the planned date is worth drawing at all.
   *
   * Not "only when in the past", which is what it used to be: in *Later* the date
   * is the only thing saying *how* much later, and in the archive there is no
   * column date at all.
   *
   * A task with **no** planned day cannot be stored — the column is `NOT NULL`
   * and `newTaskFields` is what guarantees every write carries one — but the
   * guard stays: `dayLabel(undefined)` throws inside the render, and the way
   * that failed was the whole board going blank rather than one chip going
   * missing. A card draws the date it has.
   */
  const showPlanned = $derived(Boolean(task.planned_on) && task.planned_on !== columnDate)

  /**
   * Whose list this task is in, where that is somebody else.
   *
   * Only where the list chip is drawn at all — several lists on one board — so
   * it rides on the chip and is never a line of its own: under the `list`
   * grouping the column *is* the list, and with one list selected every card
   * would repeat the same name.
   */
  const owner = $derived(list?.owner && me && list.owner !== me ? list.owner : null)

  /**
   * Where the card is while it is being carried, or null while it is at rest.
   *
   * `position: fixed` at the pointer, offset by the grip it was picked up by, at
   * the width of the slot it left — so the card under the finger is the card,
   * not a picture of one. Three details are load-bearing:
   *
   * - **`pointer-events: none`**, or `elementFromPoint` would find the card
   *   itself rather than the column beneath it and every drop would land where
   *   it started.
   * - **`transition-none`** while carried, which is a class further down rather
   *   than a value here: the card's ordinary `transition` includes `transform`,
   *   so without it the card eases towards the pointer 150ms behind the finger.
   * - **The width is the slot's**, not the destination column's. A card keeps
   *   the size it was picked up at for the length of the gesture; resizing it
   *   mid-air would make a drop between two columns of different widths a
   *   moving target.
   */
  const lifted = $derived(
    carried && carry?.originRect
      ? {
          x: carry.x - carry.grabOffset.x,
          y: carry.y - carry.grabOffset.y,
          width: carry.originRect.width,
        }
      : null
  )

  /** The card's own element, for the settle to measure and move. */
  let node = $state(null)

  // Runs once per landing, after the store has moved the card and the DOM with
  // it: the destination cannot be measured before it exists. It writes nothing
  // reactive — `settleInto` touches inline styles and nothing else — so this
  // cannot be the effect that reads what it writes.
  $effect(() => {
    const landing = carry?.landing
    if (!node || !justLanded(landing, task.client_id)) return
    settleInto(node, landing)
  })

  /**
   * The card's own surface, when somebody has chosen a colour for the task.
   *
   * **A tint of the card's own surface, not a colour over the page.** The card
   * is `bg-ink-soft` on an `ink` page, and that difference is what makes it
   * read as a card at all — so the colour is mixed *into* `ink-soft` rather
   * than laid over `transparent` the way a calendar block does it. The block
   * can afford the second treatment because it sits on the hour grid rather
   * than on a surface of its own.
   *
   * **Twelve per cent, and the number was measured rather than chosen.** What
   * a tint can spoil is the one chip on a card that changes what you do next:
   * `text-alarm` on a due date that has passed. Contrast against the card, computed over
   * all six tokens, worst case `amber` — 3.94:1 on a plain card, 3.18:1 at 12%
   * and 2.95:1 at 16%. The title (`text-paper`) stays above 11:1 and a `.meta`
   * chip above 6:1 either way. The edge bar carries the colour at full
   * strength, where three pixels cannot be read through, so the tint does not
   * have to be strong to say which colour a task is.
   *
   * Null where the task names no colour, and then **nothing at all** is
   * written: an existing task draws exactly as it did, which the picker's
   * *List colour* choice is the way back to. A card does not paint the list's
   * colour, which is the one place the precedence in `taskColour` is not
   * wanted — the dot beside the list's name is what says the list, and a board
   * of tinted cards would say it six times over in a colour nobody chose for
   * the task.
   */
  const paint = $derived(
    task.colour
      ? {
          edge: taskColour(task),
          surface: `color-mix(in srgb, ${taskColour(task)} 12%, var(--color-ink-soft))`,
        }
      : null
  )

  /** The planned time, which belongs beside the planned date and not after the due one. */
  const clock = $derived(wallClock(task.planned_at))

  const chips = $derived(
    [
      estimateLabel(task.duration_minutes),
      task.priority ? PRIORITY_LABELS[task.priority] : null,
      stepCount(task),
    ].filter(Boolean)
  )
</script>

<!-- `data-client-id` is the identity everywhere: a task recorded on this device
     has no server id until it syncs, and the drag reads this attribute to work
     out which card is which. -->
<!-- Focusable, because the keyboard path is the version of the drag that
     works and the pointer one is the enhancement over it: `↑`/`↓` reorder,
     `←`/`→` move to the next column, Enter opens and Space ticks. The two
     buttons inside keep their own places in the tab order after it.

     `touch-pan-y` is `touch-action: pan-y`, and it is the half of the touch
     story a listener cannot do: the browser decides at *touchstart* what a
     gesture is for, so this is what stops a sideways drag of a card being
     claimed as a scroll before any handler has run. Vertical panning is left to
     the browser, which is what keeps a long column scrollable with a thumb —
     and once the card is actually lifted, `drag.svelte.js`'s non-passive
     `touchmove` handler prevents that too. -->
<article
  bind:this={node}
  data-client-id={task.client_id}
  data-done={done}
  data-drawing={drawing ? 'true' : undefined}
  data-carrying={carried ? 'true' : undefined}
  tabindex="0"
  class="flex touch-pan-y items-center gap-3 rounded-lg border border-white/10
         bg-ink-soft px-3 py-2 hover:border-white/30 hover:bg-dusk/10
         focus-visible:border-dusk-lift focus-visible:outline-none
         {carried ? 'transition-none shadow-2xl shadow-black/40' : 'transition'}"
  data-task-colour={task.colour ?? undefined}
  style:border-left-width={paint ? '3px' : undefined}
  style:border-left-color={paint?.edge}
  style:background={paint?.surface}
  style:position={lifted ? 'fixed' : undefined}
  style:left={lifted ? '0px' : undefined}
  style:top={lifted ? '0px' : undefined}
  style:width={lifted ? `${lifted.width}px` : undefined}
  style:transform={lifted ? `translate3d(${lifted.x}px, ${lifted.y}px, 0) scale(1.02)` : undefined}
  style:will-change={lifted ? 'transform' : undefined}
  style:pointer-events={lifted ? 'none' : undefined}
  style:z-index={lifted ? 50 : undefined}
  oncontextmenu={menu ? (event) => menu.contextmenu(event, task) : undefined}
  onpointerdown={(event) => {
    // Both, from one press: the drag lifts the card after its short press and
    // the menu opens if the finger is still there and still. Whichever wins
    // cancels the other — see `task-menu.svelte.js`.
    if (liftable) onstart(event, task)
    menu?.press(event, task)
  }}
  onkeydown={(event) => {
    // Only the card's own keys. A key pressed inside the tickbox or the title
    // belongs to that button, and stealing Space from one would break it.
    if (event.target === event.currentTarget) onkey(event, task)
  }}
>
  <!-- 44px of hit target around a 32px box, and the negative margin is what
       makes that free: the button occupies its old 32px of layout and reaches
       6px past it on every side, into the card's own padding and the gap before
       the title. A thumb at 320px has the whole of it; the drawing did not
       change, and neither did the row.

       Centred on the card by `items-center` above, not by the margin: the
       margin is symmetric and moves nothing. `items-start` pinned the box to
       the top of the content box, which is centred only on a card exactly
       32px tall — measured 4px high beside a chip row or a second line, and
       54px high beside a seven-line title at 320. -->
  <button
    class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
    data-tick
    aria-pressed={done}
    aria-label={done ? `Untick ${task.title}` : `Tick ${task.title}`}
    disabled={readOnly}
    onpointerdown={(event) => event.stopPropagation()}
    onclick={() => ontoggle(task)}
  >
    <TickMark {done} icon={task.icon} {drawing} />
  </button>

  <div class="min-w-0 flex-1">
    <!-- One of the card's two actions, and the one that opens the modal. -->
    <button
      class="block w-full text-left text-sm {done ? 'text-haze' : ''}"
      data-title
      onclick={() => {
        // The release that ended a long press is reported as a click on
        // whatever the finger was over, and this button is usually it — so the
        // modal would open behind the menu that press just asked for. The same
        // afterglow the drag's release is read through.
        if (!menu?.justOpened) onopen(task)
      }}
    >
      <!-- The strike is a background line rather than `line-through`, because
           it has to be drawn in from the left — and rather than one scaled
           element, because a scaled line crosses the middle of a wrapped
           title instead of each of its lines. `box-decoration-break: clone`
           gives every line its own. -->
      <span data-strike class="strike {done ? 'struck' : ''} {drawing ? 'strike-draw' : ''}"
        >{task.title}</span>
    </button>

    {#if chips.length || showPlanned || clock || task.due_on || showList || task.description}
      <!-- The planned day and the planned time are adjacent, and the due date
           follows them: the two halves of *when this is meant to happen* read
           as one thing, and a due chip between them read as neither. -->
      <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <!-- Never red. A plan for a day that has gone is past, not late; the
             due chip is the one that can be. `plannedLabel` and never
             `dayLabel` — one rule for how a day is spelled, shared with the
             due chip beside it. -->
        {#if showPlanned}
          <span class="meta" data-chip="planned">
            {plannedLabel(task.planned_on, today)}
          </span>
        {/if}
        {#if clock}
          <span class="meta" data-chip="time">{clock}</span>
        {/if}
        {#if task.due_on}
          <!-- Red once the day it was due on has gone, and not on the day
               itself: see `overdue`. -->
          <span class="meta {overdue ? 'text-alarm' : ''}" data-chip="due">
            {dueLabel(task.due_on, today)}
          </span>
        {/if}
        {#each chips as chip (chip)}
          <span class="meta">{chip}</span>
        {/each}
        <!-- Says there is something the card is not showing, which is what
             makes opening the modal worth a tap. The glyph alone: a
             description is prose, a card is a line, and a label beside the
             mark said it twice. `role="img"` is what lets the name stand in
             for the glyph, since a bare span may not carry one. -->
        {#if task.description}
          <span class="meta" data-chip="description" role="img" aria-label="has notes">¶</span>
        {/if}
        {#if showList && list}
          <span class="meta flex items-center gap-1.5" data-chip="list">
            <span
              class="size-2 rounded-full"
              style:background={chipColour(list.colour)}
              aria-hidden="true"
            ></span>
            {list.name}
            {#if owner}
              <span data-chip-owner>· {owner}</span>
            {/if}
          </span>
        {/if}
      </div>
    {/if}
  </div>
</article>
