<script>
  import { tick as painted, untrack } from 'svelte'
  import { get } from 'svelte/store'

  import Board from '../../lib/todos/Board.svelte'
  import Frame from '../../lib/Frame.svelte'
  import { COLUMN } from '../../lib/todos/column.js'
  import TaskMenu from '../../lib/todos/TaskMenu.svelte'
  import TaskModal from '../../lib/todos/TaskModal.svelte'
  import { tick, untick } from '../../lib/todos/fields.js'
  import { markTicked, nextSettleIn, settlingNow } from '../../lib/todos/tick.js'
  import {
    DEFAULT_GROUPING,
    GROUPINGS,
    dropNeighbours,
    groupingFor,
    listOrder,
    newTaskRank,
  } from '../../lib/todos/groupings.js'
  import { selectedLists, storedLists, todoSettings } from '../../lib/todo-settings.js'
  import { cardDrag } from '../../lib/todos/drag.svelte.js'
  import { taskMenu } from '../../lib/todos/task-menu.svelte.js'
  import { between, isRank, needsRebalance, placeBetween, spread } from '../../lib/todos/rank.js'
  import { dayLabel, today as todayKey } from '../../lib/day.js'
  import { chipColour } from '../../lib/palette.js'
  import { wide } from '../../lib/media.js'
  import { resource } from '../../lib/resource.svelte.js'
  import { connection } from '../../lib/sync.js'
  import {
    archive,
    archiveListId,
    archiveNext,
    archiveRead,
    ensureArchive,
    ensurePomodoros,
    ensurePreferences,
    ensureTodoLists,
    ensureTodos,
    me,
    persistPreferences,
    preferenceSection,
    preferences,
    ready,
    saveTodo,
    saveTodos,
    settleActiveTasks,
    todoLists,
    todos as todoStore,
  } from '../../lib/store.js'

  /**
   * The board: one list, one grouping, one layout, columns of cards.
   *
   * Everything on screen is derived from the stores. There is no local copy of
   * a task anywhere in this file, which is the rule rather than a style: a task
   * corrected on another device arrives by a read replacing the store, and a
   * view holding its own snapshot could not see it.
   *
   * The interesting behaviours are one line each, because the rules they follow
   * live in their own modules: which column a task is in (`groupings.js`),
   * where in a column a pointer is pointing (`dropindex.js`), what key a card
   * dropped between two others gets (`rank.js`), and how a grouping is laid out
   * (`Board.svelte`). What is left here is the *coupling* — which list, which
   * grouping, which layout — and one function, `place`, that every way of
   * moving a card goes through.
   */

  const today = todayKey()

  /**
   * Which lists are on screen, how they are grouped, and how that is laid out.
   *
   * `chosen` holds the ids **as chosen or as stored**, unvalidated: the view is
   * restored before the lists have necessarily arrived, and checking the ids
   * against a list that is not there yet would drop a real choice. What the
   * board reads is `listIds`, which is this validated against the account's
   * lists on every read — see `selectedLists`.
   */
  let chosen = $state([])
  // The grouping module's default and never a second one here: this said
  // `'date'` while `groupingFor` fell back to something else, so an account with
  // nothing remembered and one remembering a grouping that no longer exists
  // opened on two different boards.
  let groupingId = $state(DEFAULT_GROUPING)
  let layoutId = $state('stacked')

  /** Whether the saved view state has been read, so mirroring it back is not a save. */
  let restored = $state(false)

  /**
   * Which controls the reader has already moved, so the restore leaves them.
   *
   * The same guard `openBands` needs, and the rule `ensurePreferences` follows
   * one level along: **a choice made while the read is outstanding is a real
   * choice.** `restore` assigns after an await, so a grouping picked in that
   * window was being put back by the stored one landing on top of it. Per
   * control rather than one flag for the page, or choosing a grouping would
   * also cost the remembered list.
   *
   * Not `$state`: it is read once, after an await, by code that must not re-run
   * because of it.
   */
  const steered = new Set()

  /**
   * What was last done with the keyboard, for anything listening.
   *
   * A move made with an arrow key has no picture of itself — the card simply
   * is somewhere else — so the one thing that says it happened is this.
   */
  let moved = $state('')

  // A constant query: nothing this page loads is read by window, so there is
  // nothing for a change of view to re-fetch. Arriving here a second time
  // paints from the store, and `revalidate.js` is what asks the server whether
  // anything moved.
  const loaded = resource(
    () => 'todos',
    async () => {
      const held = await Promise.all([
        ensureTodos(),
        ensureTodoLists(),
        ensurePreferences(),
        // Nothing on this page draws a pomodoro. They are here because Start a
        // pomodoro has to know whether one is already running — a write that
        // read the server to find out would be a write waiting on the network,
        // which is the one thing this app does not do.
        ensurePomodoros({ start: today, end: today }),
      ])
      // A focus block that ended while the app was closed still ended, and the
      // task it activated must not still be counting. See `settleActive`.
      await settleActiveTasks()
      return held
    },
    { name: 'todos' }
  )

  const lists = $derived($todoLists ?? [])

  /** The chips, in the one order this half draws its lists in. */
  const chips = $derived(listOrder(lists))

  /**
   * The lists on screen, validated and in the order the chips draw them.
   *
   * The validation is not defensiveness: lists are remembered per account and
   * lists are deletable, so the board can arrive pointed at one that a *second
   * device* removed — and a remembered id nothing matches left every column
   * empty with a chip row that did not include it. Caught by deleting a list
   * from the Lists page and walking back to the board. Being a *set* only moves
   * where the answer comes from; `selectedLists` is the same rule for many.
   */
  const listIds = $derived(selectedLists(chosen, chips))

  /** The selected lists themselves, in list order. */
  const selected = $derived(chips.filter((one) => listIds.includes(one.id)))

  /** More than one list at a time, which is what a card has to say its list on. */
  const several = $derived(selected.length > 1)

  /**
   * The list a typed task is created into.
   *
   * The **first selected list in list order**, because a quick-add has to name
   * one and there is no honest way to choose between several — and the first in
   * that order is the inbox whenever the inbox is among them, which is where a
   * task with no `#list` has always landed. Said out loud under the box
   * whenever there is a choice to be wrong about; see `into` below.
   */
  const creating = $derived(selected[0] ?? null)

  const listsById = $derived(Object.fromEntries(lists.map((one) => [one.id, one])))

  /** Who is signed in, which is what makes somebody else's list somebody else's. */
  const username = $derived($me?.username ?? null)

  /**
   * The owner of a list, where that is not the signed-in account.
   *
   * Null for one's own and null while the account is unknown: a mark saying
   * whose a list is must not be drawn on a guess.
   *
   * @param {import('../../lib/generated/types.gen').TodoListOut|null|undefined} one
   * @returns {string|null}
   */
  function othersOwner(one) {
    return one?.owner && username && one.owner !== username ? one.owner : null
  }

  /**
   * The list to *say* a typed task is going into, or null to stay quiet.
   *
   * Only where there is more than one selected list, because that is where the
   * answer could surprise somebody: with one list on screen the box is
   * obviously about that list, and a `#Inbox` under every column would be the
   * kind of restatement the record table dropped its weekday for. The `list`
   * grouping says nothing either, since there each column *is* a list and its
   * own preset decides.
   */
  const into = $derived(!byList && several ? creating : null)

  /** What the groupings that need it read, validated and complete. */
  const settings = $derived(todoSettings(preferenceSection($preferences, 'todos')))

  const grouping = $derived(groupingFor(groupingId))

  /**
   * The move-between-lists grouping, which is the one that ignores the chips.
   *
   * Every other grouping draws one list; this one draws them all, so a control
   * choosing between them would be a control with nothing to do — the chips are
   * hidden rather than left on screen saying something that is not true.
   */
  const byList = $derived(grouping.id === 'list')

  /**
   * Whether the archive is what is on screen, which is a read-only board.
   *
   * The archive chip is exclusive — selecting it deselects everything else and
   * selecting anything else deselects it — so one selected list of that kind is
   * the whole of the condition. `selectedLists` is what keeps a stored set from
   * arriving in the shape the chips cannot produce.
   */
  const showingArchive = $derived(
    !byList && selected.length === 1 && selected[0].kind === 'archive'
  )

  /**
   * Which column is drawing the archive, or null where none is.
   *
   * The archive is the one paged collection, so it is the one column that can
   * offer an older page — and which column that is depends on the view. Its
   * own chip draws it as a single column called `archive`; the `list` grouping
   * draws it under the list's own id, like every other list. Matched on `kind`
   * and never on the name, because both system lists are renameable.
   */
  const archiveColumn = $derived(
    showingArchive
      ? 'archive'
      : byList
        ? (lists.find((one) => one.kind === 'archive')?.id ?? null)
        : null
  )

  /**
   * The layout in force, which the grouping has the last word on.
   *
   * A stored `layout` naming one this grouping does not offer falls back to its
   * first rather than drawing nothing — the same rule `groupingFor` follows,
   * and for the same reason: a preferences document is written by whatever
   * version last touched it.
   */
  const layout = $derived(
    grouping.layouts.includes(layoutId) ? layoutId : grouping.layouts[0]
  )

  /** A toggle is only worth drawing where there is a choice and room for one. */
  const choosable = $derived(grouping.layouts.length > 1 && $wide)

  /**
   * How the board is arranged: the layout in force, except that the archive is
   * always a stack.
   *
   * The archive is one column whatever layout the grouping it was reached from
   * remembers, and one column in a row or a 2×2 grid is a stack drawn wrongly —
   * half the frame in a quadrant, the whole of it in a column row.
   */
  const arrangement = $derived(showingArchive ? 'stacked' : layout)

  /**
   * Whether the board breaks out of the half's column to fill the frame.
   *
   * The heading and the toolbar sit in the column (`lib/todos/column.js`) in
   * every view, so nothing above the board moves when it changes shape. A stack
   * fills that column, where a card 1,500px wide is a line nobody can follow; a
   * column row and a 2×2 grid fill the frame from its left edge, because columns
   * are laid out from a per-column minimum and a five-column grouping bounded by
   * a reading width was clipped at every desktop width.
   */
  const breakout = $derived(arrangement !== 'stacked')

  // The archive is the one collection that is paged and the one that is not in
  // the snapshot: it is read when it is looked at, and not before. Two views
  // look at it — the archive chip, and the `list` grouping, where it is a
  // column like any other. The loader writes only `archive`, so there is
  // nothing here to feed back.
  //
  // The connection is part of the query so that a read which could not reach
  // the server is asked again when it can: the digest cannot say the archive
  // moved, because to this device nothing about it did — it was never read.
  // `ensureArchive` answers from the store once a read has confirmed it, so a
  // connection coming and going costs nothing after that.
  const archiveLoad = resource(
    () => (showingArchive || byList ? $connection : null),
    (wanted) => (wanted ? ensureArchive() : Promise.resolve([])),
    { name: 'todo archive' }
  )

  /**
   * The tasks the columns are built from.
   *
   * The archive is two sources deliberately, wherever it is drawn.
   * `ensureArchive` reads a page from the server, ordered by the timestamp only
   * the server knows; a task this device has just archived is still in `todos`,
   * carrying the archive's `list_id` and no timestamp at all. Drawing both
   * means a cleanup made with no connection can still be looked at, and the
   * duplicate a reconnect produces is settled on `client_id`.
   */
  const tasks = $derived.by(() => {
    const all = $todoStore ?? []
    const held = byList ? all : all.filter((row) => listIds.includes(row.list_id))
    if (!byList && !showingArchive) return held
    const mine = new Set(held.map((row) => row.client_id))
    return [...held, ...$archive.filter((row) => !mine.has(row.client_id))]
  })

  /**
   * Bumped when a settling window opens or closes, and read by nothing else.
   *
   * **What re-derives `settling`, and the only thing that does.** The set is a
   * clock read (`settlingNow`), and a `$derived` over a clock read alone would
   * compute once and never again — nothing reactive would tell it a window had
   * closed. So it reads this counter, and the counter is written from exactly
   * two places, neither of them an effect: the tick gesture (`toggle`), and the
   * timeout that gesture schedules for the moment the earliest open window
   * closes (`wake`). Nothing reads what it writes, so there is nothing to loop.
   */
  let settleClock = $state(0)

  /** The pending `wake`, so a second tick replaces rather than stacks it. */
  let settleTimer = null

  /**
   * Re-derive the settling set, and come back when the next window closes.
   *
   * Scheduled from the stamps rather than from the tick that asked, so a window
   * opened by another tick in the meantime is still closed on time. One timer
   * at most; a page left mid-window is cleared by the effect below.
   */
  function wake() {
    settleClock += 1
    clearTimeout(settleTimer)
    const left = nextSettleIn()
    // A frame past the edge, so the read lands after the window and not on it.
    settleTimer = left === null ? null : setTimeout(wake, left + 16)
  }

  $effect(() => () => clearTimeout(settleTimer))

  /**
   * Tasks ticked on this device a moment ago, still drawn where they were.
   *
   * Plain is the one grouping that moves a card for a tick — to the end of its
   * column — and a card vanishing from under the finger that ticked it takes its
   * own animation with it and leaves the reader nowhere to untick a mis-tap. So
   * for `SETTLE_MS` it keeps its slot. Every other grouping ignores the set.
   * Ticks arriving from another device are not in it: nobody here made them.
   */
  const settling = $derived.by(() => {
    settleClock
    return settlingNow()
  })

  /**
   * What the archive's column says while no read has confirmed it, or null.
   *
   * Never a count and never *Nothing here yet*: see `archiveRead`.
   */
  const unread = $derived(
    $archiveRead
      ? null
      : archiveLoad.loading
        ? 'Reading the archive…'
        : 'The archive needs a connection'
  )

  /**
   * The archive has no order of its own, so the chip view is not a grouping.
   *
   * A task arrives there by being finished or abandoned, never by being placed
   * — so a rank there would be a number with no meaning and a gesture with no
   * effect. It is drawn as one column, newest arrival first, and nothing in it
   * can be dragged.
   */
  const columns = $derived(
    showingArchive
      ? [
          {
            id: 'archive',
            label: selected[0]?.name ?? 'Archive',
            hint: 'Newest first',
            preset: {},
            date: null,
            paged: Boolean($archiveNext),
            unread,
            tasks: tasks.toSorted((a, b) =>
              (b.archived_at ?? '9999').localeCompare(a.archived_at ?? '9999')
            ),
          },
        ]
      : grouping.columns(tasks, today, settings, lists, { settling }).map((column, _, all) => ({
          ...column,
          sweepTo: sweepTarget(column, all),
          // Under the `list` grouping a column is a list, and a shared list's
          // done tasks go to its owner's archive — which that column's cleanup
          // question has to say, or a member watches them disappear.
          archiveOwner: byList ? othersOwner(listsById[column.id]) : null,
          // Only the archive, and only while the store holds a cursor: the end
          // of a paged collection is said by the absence of a marker, so a
          // column with no cursor behind it draws no control at all.
          paged: column.id === String(archiveColumn) && Boolean($archiveNext),
          unread: column.id === String(archiveColumn) ? unread : null,
          // The route's to derive rather than the grouping's to declare:
          // `preset` is what the column's quick-add fills in, which is the same
          // function a drop into it uses. `date` *is* the grouping's now — a
          // column that is one day is a property of the column, and phase 3's
          // `columnDate(groupingId, …)` was a lookup table standing in for it.
          preset: grouping.preset(column.id, today, settings, lists),
        }))
  )

  /**
   * Where a column's open tasks would be swept to, as its question names it.
   *
   * The grouping names the target (`sweep`) and its `drop` is what the move
   * writes, so the date in the question is **read off that same patch** rather
   * than worked out a second time: whatever *Later* comes to mean, the sentence
   * and the write cannot disagree. Every open task in *Past* gets the same
   * patch, so the first one's is the one to name.
   *
   * @param {object} column A column the grouping drew.
   * @param {Array<object>} all Every column of the grouping, to find the target.
   * @returns {{id: string, label: string, date: string|null}|null}
   */
  function sweepTarget(column, all) {
    if (!column.sweep) return null
    const target = all.find((one) => one.id === column.sweep)
    if (!target) return null
    const first = column.tasks.find((row) => !row.done_at)
    const planned = first
      ? grouping.drop(first, target.id, today, settings, lists).planned_on
      : null
    return { id: target.id, label: target.label, date: planned ? dayLabel(planned) : null }
  }

  /** Only true while there is genuinely nothing to draw — never "a request is out". */
  const loading = $derived(
    (loaded.loading || ((showingArchive || byList) && archiveLoad.loading)) &&
      tasks.length === 0
  )

  /**
   * The done tasks on screen, which is what the toolbar's cleanup takes.
   *
   * Over every selected list rather than one of them, which is why the count on
   * the button moves when a chip does: `tasks` is already the selection, and
   * cleanup acting on less than what the board is showing would be a button
   * whose number disagreed with the cards under it.
   */
  const done = $derived(tasks.filter((row) => row.done_at))

  /**
   * What cleanup's question adds when some of `done` is not going to this
   * account's archive.
   *
   * The server sends a shared list's done tasks to its **owner's** archive, so a
   * member pressing Clean up would otherwise watch them vanish from a board
   * whose own archive never receives them. One sentence per owner, naming the
   * lists in list order, and only lists that actually contribute a done task.
   */
  const elsewhere = $derived.by(() => {
    const byOwner = new Map()
    for (const one of selected) {
      const owner = othersOwner(one)
      if (!owner || !done.some((row) => row.list_id === one.id)) continue
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), one.name])
    }
    const names = new Intl.ListFormat('en', { type: 'conjunction' })
    return [...byOwner].map(
      ([owner, held]) =>
        `Tasks from ${names.format(held)} go to ${owner}’s archive.`
    )
  })

  const drag = cardDrag({ onDrop })

  /**
   * The right-click menu, which is the board's and not a card's.
   *
   * One machine per page, as the drag is: it is the drag whose carry a long
   * press has to cancel, and the two have to be the pair that a press on one
   * card resolves between.
   */
  const menu = taskMenu()
  // The two are introduced here because this is where both exist: a long press
  // that has become a menu has to put back the card the drag lifted at
  // `LIFT_MS`, and neither machine may reach for the other on its own.
  menu.oncarry = () => drag.cancel()

  // Nothing reactive is read before the first await, so this effect has no
  // dependencies and runs once — the shape that cannot re-trigger itself.
  $effect(() => {
    restore()
  })

  /**
   * Put the board back on the lists, grouping and layout it was last left on.
   *
   * **From the snapshot first, and then from the read.** `ensurePreferences`
   * waits on the network whenever this session has not confirmed a read yet —
   * which is every reload — so restoring only after it painted the default
   * grouping for as long as the connection took, over a snapshot that already
   * knew better: on a slow start an account that keeps Date sat on Plain. The
   * held copy is applied as soon as the device has read its own disk, and the
   * confirmed one over it, so another device's change still arrives. Saving
   * waits for the confirmed read, as it always has.
   */
  async function restore() {
    await ready()
    const held = get(preferences)
    if (held) apply(preferenceSection(held, 'todos'))
    apply(preferenceSection(await ensurePreferences(), 'todos'))
    restored = true
  }

  /**
   * Take one stored view, leaving every control the reader has already moved.
   *
   * @param {object} stored The `todos` section of the preferences document.
   */
  function apply(stored) {
    if (!steered.has('lists')) chosen = storedLists(stored)
    if (!steered.has('grouping') && GROUPINGS[stored.grouping]) groupingId = stored.grouping
    if (!steered.has('layout') && typeof stored.layout === 'string') layoutId = stored.layout
  }

  $effect(() => {
    // Reading them here is what subscribes this effect to all three controls.
    // The store drops a save that matches what is stored, so arriving on a
    // remembered view writes nothing.
    // `list` is written as `undefined` rather than left alone, which
    // `JSON.stringify` drops: the account that had the old single-id key keeps
    // it otherwise, and two spellings of which lists are showing is the shape
    // that lets a stale one start answering. `storedLists` prefers `lists`, so
    // the migration is read once and then gone.
    const view = { list: undefined, lists: listIds, grouping: groupingId, layout: layout }
    // An empty selection is never a choice — `selectedLists` falls back to the
    // inbox — so it means the lists have not arrived, and saving it would write
    // this device's nothing over the account's own.
    if (!restored || !listIds.length) return
    // **`untrack`, and it is not a precaution.** `persistPreferences` replaces
    // the named section, so everything else living in this one has to be
    // carried through or a change of grouping would delete it — and reading it
    // from `$preferences` *tracked* makes this an effect that reads what it
    // writes. It does not throw: the write lands after an await, so Svelte's
    // depth counter has reset by the time it arrives and the effect loops for
    // ever with no error at all. Measured as every board test failing at once,
    // with the cards on screen and the tickbox doing nothing.
    //
    // The whole section rather than `settings` alone, which is what it used to
    // carry: the calendar then put `calendar_mode` and `calendar_due` in here
    // too, and a walk from a day-mode calendar to the board and back arrived on
    // Week. Naming the keys to keep is a list that has to be extended by
    // whoever adds the next one, and was not.
    const stored = untrack(() => preferenceSection($preferences, 'todos'))
    persistPreferences('todos', { ...stored, ...view })
  })

  /** Every ordinary list, which is what *All* gathers and what it is pressed for. */
  const everyOrdinary = $derived(
    chips.filter((one) => one.kind !== 'archive').map((one) => one.id)
  )

  const allSelected = $derived(
    everyOrdinary.length > 0 &&
      everyOrdinary.length === listIds.length &&
      everyOrdinary.every((id) => listIds.includes(id))
  )

  /**
   * Take a list in or out of the selection.
   *
   * Three rules, and the archive's is the one that is not symmetrical:
   *
   * - **At least one stays.** Tapping the last selected chip does nothing —
   *   `selectedLists` would put the inbox back anyway, so the alternative is a
   *   tap that silently moves the board to a list nobody asked for.
   * - **The archive is exclusive**, both ways: selecting it shows the archive
   *   alone, and selecting anything else deselects it. It is the read-only
   *   collection and the one that is paged, so a board holding it *and* an
   *   ordinary list could neither be dragged in nor added to.
   * - **Anything else toggles.**
   *
   * @param {import('../../lib/generated/types.gen').TodoListOut} one The list
   *   whose chip was pressed.
   */
  function toggleList(one) {
    steered.add('lists')
    if (one.kind === 'archive') {
      chosen = [one.id]
      return
    }
    if (listIds.includes(one.id)) {
      if (listIds.length === 1) return
      chosen = listIds.filter((id) => id !== one.id)
      return
    }
    chosen = [...listIds.filter((id) => listsById[id]?.kind !== 'archive'), one.id]
  }

  /** Show every list except the archive, which is never part of *all*. */
  function selectAll() {
    steered.add('lists')
    chosen = everyOrdinary
  }

  /**
   * Put a task in a column at an index, which is one write in the ordinary case.
   *
   * **The one place a card moves, whatever moved it.** A pointer drop, an arrow
   * key and a card dropped on a pager tab all come through here, so "the
   * keyboard does the same thing as a drag" is a fact about the code rather
   * than a claim two implementations have to keep agreeing on.
   *
   * Two halves, computed separately and neither knowing about the other: the
   * grouping says what *field* changes, and the index says what *rank* it gets.
   * That is what makes "place it exactly where it was dropped" one behaviour in
   * every grouping rather than a special case per view.
   *
   * @param {object} task The task being moved.
   * @param {object} column The column it is going into.
   * @param {number} index Where among the column's other cards, clamped here —
   *   a drop on a pager tab names a column without naming a place in it, and
   *   asks for the end.
   * @returns {Promise<unknown>|false} The write, or `false` where there was
   *   nothing to write. Truthy either way for a caller that only wants to know
   *   whether anything happened — and awaitable for the callers that have to
   *   know *when* it did: a keyboard move must not read the column's order
   *   until the move before it has landed, and a sweep aims the focus at a
   *   card that does not exist until then.
   */
  function place(task, column, index) {
    const inside = column.tasks.some((row) => row.client_id === task.client_id)
    // A read-only column refuses a *reorder*, never an arrival. Dropping onto
    // the archive is exactly what *won't do* means — in the archive, `done_at`
    // left alone — so the drop is the verb and there is nothing to forbid;
    // what there is no such thing as is a place inside it, because a task gets
    // there by being finished or abandoned and never by being put there.
    if (column.readonly && inside) return false
    const others = column.tasks.filter((row) => row.client_id !== task.client_id)
    // The slot *and* the ranks either side of it come from one call. A column
    // with an open and a done section (Plain) sorts each section alone, so at
    // the boundary the card before the slot and the card after it can be ranked
    // either way round — and `between` of the two then lands the card a slot
    // late even with the slot clamped. Without sections this is exactly the
    // clamp and the pair this function always read.
    const { at, lower, upper } = dropNeighbours(column, task, index)
    const was = column.tasks.findIndex((row) => row.client_id === task.client_id)
    const patch = grouping.drop(task, column.id, today, settings, lists)

    // Dropped back where it came from: no field to change and the same
    // neighbours either side. Writing anyway would queue an intent that says
    // nothing, and on a slow connection that is a write somebody waits for.
    // A drop clamped back to its own slot at a section boundary ends here too,
    // which is what stops an arrow key at the boundary.
    if (!Object.keys(patch).length && was === at) return false

    const { rank, rebalance } = placeBetween(lower, upper)
    const moved = { ...task, ...patch, rank }

    if (!rebalance) {
      return saveTodo(moved)
    }

    // The key this drop would need has grown far enough to be silly — or a
    // neighbour's key is not one the encoding can read at all — so the drop
    // re-ranks its own column instead — one batch, short keys, and the
    // task in its new place. The operation that would have degraded is the one
    // that repairs it, and nobody had to schedule anything.
    const ordered = [...others.slice(0, at), moved, ...others.slice(at)]
    const fresh = spread(ordered.length)
    return saveTodos(ordered.map((row, spot) => ({ ...row, rank: fresh[spot] })))
  }

  /**
   * Move every open task in a column to the column it sweeps into, as one gesture.
   *
   * **The fields are the target's own `drop`**, the function a card dragged
   * there already goes through — so moving *Past* to *Later* writes exactly what
   * dragging each card there would, and there is no second rule for what
   * *Later* means. Done tasks stay: one planned in the past was done then.
   *
   * **The rank is the end of the target**, in the order the tasks already had.
   * A batch move has no drop point, and the end is the honest answer, as a drop
   * on a pager tab already is. Where the keys would grow silly the target is
   * re-ranked in the same batch, which is `place`'s rule for one card applied
   * to several.
   *
   * One `saveTodos`, so it is one queue entry however many tasks it moves, and
   * the flush chunks it at the server's cap.
   *
   * @param {{id: string, sweepTo: {id: string}|null, tasks: Array<object>}} column
   * @returns {Promise<unknown>|false} The write, or `false` where nothing moved.
   */
  function sweep(column) {
    const target = columns.find((one) => one.id === column.sweepTo?.id)
    const moving = column.tasks.filter((row) => !row.done_at)
    if (!target || !moving.length) return false
    const leaving = new Set(moving.map((row) => row.client_id))
    const staying = target.tasks.filter((row) => !leaving.has(row.client_id))
    const tail = staying.at(-1)?.rank ?? null
    // A malformed key at the end cannot be appended after, so the target is
    // re-ranked — which is also what repairs it.
    const readable = !tail || isRank(tail)
    let last = readable ? tail : null
    const moved = moving.map((task) => {
      const rank = between(last, null)
      last = rank
      return { ...task, ...grouping.drop(task, target.id, today, settings, lists), rank }
    })
    if (readable && !moved.some((row) => needsRebalance(row.rank))) return saveTodos(moved)
    const ordered = [...staying, ...moved]
    const fresh = spread(ordered.length)
    return saveTodos(ordered.map((row, spot) => ({ ...row, rank: fresh[spot] })))
  }

  /**
   * Place a dropped card.
   *
   * @param {{task: object, columnId: string|null, index: number}} drop
   */
  function onDrop({ task, columnId, index }) {
    if (!columnId || showingArchive) return
    const column = columns.find((one) => one.id === columnId)
    if (column) place(task, column, index)
  }

  /**
   * The keyboard moves still to be made, one after another.
   *
   * **Each press moves one slot from where the previous press left the card.**
   * A move reads the column's order to decide its slot, and the order only
   * changes once the write before it has reached the store — so four presses
   * with no pause used to read one order four times, and 150ms apart they read
   * whichever half-landed order happened to be there: 2, 3, 5, 8 on screen
   * while the live region said 2, 3, 4, 6. Chained, every move reads the order
   * the previous one wrote, and the sentence is built from that same read.
   */
  let nudging = Promise.resolve()

  /**
   * Move a card with the keyboard: along its column, or into the next one.
   *
   * Queued behind any move still being written — see `nudging`. The card is
   * found again by identity when its turn comes, because the task and column
   * a press was made on describe the board before the moves ahead of it.
   *
   * @param {object} task
   * @param {string} _columnId The column the card was in when the key was pressed.
   * @param {number} dx `-1` or `1` to move across, `0` to stay.
   * @param {number} dy `-1` or `1` to move along, `0` to stay.
   */
  function nudge(task, _columnId, dx, dy) {
    const clientId = task.client_id
    // A refused intent is reported by the toast the drain raises; here it only
    // means the next move reads the order as it stands.
    nudging = nudging.then(() => nudgeNow(clientId, dx, dy)).catch(() => {})
  }

  /**
   * Make one keyboard move against the board as it is now.
   *
   * Sideways is the one gesture that cannot name a place, so it lands at the
   * **same index** in the neighbouring column, clamped to its length — which is
   * as close to *where it was* as a keyboard can be. Along the column is a rank
   * change and nothing else, exactly as an in-column drag is.
   *
   * The focus is not handled here: a card that moves takes the focus with it
   * through `followFocus`, whatever moved it.
   *
   * @param {string} clientId
   * @param {number} dx
   * @param {number} dy
   * @returns {Promise<void>} Once the write has reached the store.
   */
  async function nudgeNow(clientId, dx, dy) {
    if (showingArchive) return
    const from = columns.findIndex((one) => one.tasks.some((row) => row.client_id === clientId))
    const column = columns[from]
    if (!column) return
    const spot = column.tasks.findIndex((row) => row.client_id === clientId)
    const task = column.tasks[spot]

    if (dy) {
      const to = spot + dy
      // Refused rather than clamped: a card at the top asked to go up has
      // nowhere to go, and writing a rank that changes nothing would queue an
      // intent saying nothing.
      if (to < 0 || to >= column.tasks.length) return
      const written = place(task, column, to)
      if (written) {
        announce(`Moved within ${column.label}, position ${to + 1}`)
        await written
      }
      return
    }

    const target = columns[from + dx]
    if (!target) return
    const to = Math.min(Math.max(spot, 0), target.tasks.length)
    const written = place(task, target, to)
    if (written) {
      announce(`Moved to ${target.label}, position ${to + 1}`)
      await written
    }
  }

  /**
   * The card the keyboard is on, by identity, while the focus is on the card itself.
   *
   * **A card that moves keeps the focus, whatever moved it.** A node Svelte
   * moves within a keyed `{#each}` is taken out and put back, and a card that
   * changes column is a new node altogether; either way an element holding the
   * focus loses it to `<body>`, and the next key does nothing. An arrow did
   * this, and so did the two moves nobody's key makes directly — a Space in
   * Plain settling the card at the done end 1.5s later, and a Space in Kanban
   * sending it to Done. So rather than each gesture putting the focus back
   * after its own write, the page remembers which card had it and gives it
   * back whenever the columns are redrawn with the focus on nothing.
   *
   * Only the card itself, never a control inside it: a tickbox pressed with a
   * mouse is focused by the click, and following that card to the end of Plain
   * would scroll the page to it. Any focus landing elsewhere forgets it, and so
   * does a press anywhere outside it, since a click on bare page also leaves the
   * focus on `<body>` and must not be answered by taking it back. Not reactive:
   * nothing is drawn from it.
   *
   * @type {string|null}
   */
  let keyed = null

  $effect(() => {
    const enter = (event) => {
      const node = event.target
      keyed =
        node instanceof HTMLElement && node.matches('article[data-client-id]')
          ? node.dataset.clientId
          : null
    }
    const press = (event) => {
      if (keyed && !event.target?.closest?.(`article[data-client-id="${keyed}"]`)) keyed = null
    }
    globalThis.addEventListener('focusin', enter)
    globalThis.addEventListener('pointerdown', press, true)
    return () => {
      globalThis.removeEventListener('focusin', enter)
      globalThis.removeEventListener('pointerdown', press, true)
    }
  })

  // Runs after the redraw a change to the columns causes, in the same flush,
  // so the focus is back before any further key can be dispatched. Reads the
  // columns and writes only the document's focus, which nothing here derives
  // from. Silent when the card is not drawn — a sideways move in the pager
  // lands it in a column that is not on screen.
  $effect(() => {
    columns
    followFocus()
  })

  function followFocus() {
    if (!keyed) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const card = document.querySelector(`article[data-client-id="${keyed}"]`)
    if (card instanceof HTMLElement) card.focus()
  }

  /**
   * Sweep a column from its own confirmation, and put the focus where the tasks went.
   *
   * The button that asked and the one that answered both leave with the tasks
   * — the column has nothing left to sweep — so the focus would otherwise fall
   * to `<body>`. It goes to the **first moved card** in the column it landed
   * in, which says where they went, or to that column's tab on the pager, where
   * the column is not drawn.
   *
   * @param {{id: string, sweepTo: {id: string}|null, tasks: Array<object>}} column
   */
  async function sweepAndFollow(column) {
    const first = column.tasks.find((row) => !row.done_at)?.client_id
    const into = column.sweepTo?.id
    const written = sweep(column)
    if (!written) return
    await written
    await painted()
    const active = document.activeElement
    if (active && active !== document.body) return
    const landed =
      document.querySelector(`[data-column="${into}"] article[data-client-id="${first}"]`) ??
      document.querySelector(`[data-tab="${into}"]`)
    if (landed instanceof HTMLElement) landed.focus()
  }

  /** How many keyboard moves have been announced, so the next one differs. */
  let nudges = 0

  /**
   * Say what just happened, for a reader who cannot see the card move.
   *
   * A live region only speaks when its text *changes*, and two cards moved into
   * the same position produce the same sentence — so a reader would hear the
   * first and not the second. The padding alternates to make the string
   * different; it is a zero-width space, so it draws nothing and reads as
   * nothing.
   *
   * @param {string} what
   */
  function announce(what) {
    nudges += 1
    moved = what + '\u200b'.repeat(nudges % 2)
  }

  /**
   * Create a task from a column's quick-add.
   *
   * The fields arrive **already composed** — the column's preset with the typed
   * fields over it, and `planned_on` defaulted to today — because the line
   * under the box says what Enter will do and the two must be one object rather
   * than two spellings of it. See `newTaskFields`.
   *
   * A `#list` in the text can move the task out of the list being looked at,
   * which is what somebody typing it meant; with nothing said either way it
   * lands in the list a new task is created into, which is the first of the
   * selected ones in list order.
   *
   * @param {string} title What was typed, with the recognised words removed.
   * @param {object} fields What Enter is to set, presets folded in.
   * @param {{id: string, preset: object, tasks: Array<object>}} column Which
   *   column it was typed into, whose end it is appended to.
   */
  function add(title, fields, column) {
    if (!creating) return
    // The end of the open section where a column has one, so a typed task in
    // Plain lands above the done tasks rather than among them.
    saveTodo({ list_id: creating.id, title, ...fields, rank: newTaskRank(column) })
  }

  /**
   * Tick or untick a task.
   *
   * Through the same two helpers the modal's own Tick uses, so the banking of a
   * running task cannot be spelled two ways: `active_since` non-null *is* the
   * active state, and leaving it set on a finished task would have it still
   * counting up.
   *
   * @param {object} task
   */
  function toggle(task) {
    // Stamped before the write, so the card rendering the tick finds it: this
    // is the gesture, and only a tick made here draws itself. See `tick.js`.
    if (!task.done_at) markTicked(task.client_id)
    // Before the write, so the projection that draws the tick already draws it
    // settling: the other order moves the card for one frame and back.
    // Unticking needs no window — an open task is open whatever the set holds.
    if (!task.done_at) wake()
    saveTodo(task.done_at ? untick(task) : tick(task))
  }

  /**
   * Move every done task in a set to the archive, as one gesture.
   *
   * `done_at` is kept — the archive holds what was finished as well as what was
   * abandoned, and which of the two a row is reads off that column. The arrival
   * timestamp is the server's to write: being archived *is* being in the
   * archive list, and a client-supplied `archived_at` could disagree with it.
   *
   * One `saveTodos`, so a list of six hundred is one queue entry — and the
   * flush is what chunks it at the server's cap.
   *
   * @param {Array<object>} rows The done tasks to take.
   */
  function cleanUp(rows) {
    const into = archiveListId()
    if (!into || !rows.length) return false
    return saveTodos(rows.map((row) => ({ ...row, list_id: into })))
  }

  /**
   * Clean up from a question's Archive, and put the focus somewhere that exists.
   *
   * The question and the button that raised it both leave with the tasks, so a
   * keyboard left on Archive fell to `<body>`. It goes to the **quick-add** of
   * the column that was cleaned — for the toolbar's cleanup, of the first column
   * drawing one, which on the pager is the column on screen — because the board
   * has just been emptied of finished work and adding the next thing is what is
   * left to do there. Where no column draws a quick-add, to the pressed grouping
   * pill, the nearest stable control above the board.
   *
   * **Only for a press from the keyboard** (`detail` is 0 for a click a key or
   * an assistive tool made). A tap on Archive focusing a text field would open a
   * phone's keyboard over the board it just tidied, and a mouse needs no help
   * finding its way back.
   *
   * @param {Array<object>} rows The done tasks to take.
   * @param {string|null} from The column whose own cleanup this was, or null
   *   for the toolbar's.
   * @param {MouseEvent} event The Archive press.
   */
  async function cleanUpAndFollow(rows, from, event) {
    if (!cleanUp(rows) || event.detail !== 0) return
    await painted()
    const active = document.activeElement
    if (active && active !== document.body) return
    const target =
      document.querySelector(
        from == null ? '[data-board] [data-quick-add]' : `[data-quick-add="${from}"]`
      ) ?? document.querySelector('[data-grouping-option][aria-pressed="true"]')
    if (target instanceof HTMLElement) target.focus()
  }

  /** The toolbar's Clean up button, and its question's Cancel. */
  let cleanupButton = $state(null)
  let cleanupCancel = $state(null)

  /**
   * Raise or take back the toolbar's cleanup question, keeping the focus on what exists.
   *
   * The rule a column's own question follows: asking puts the focus on Cancel,
   * the answer that changes nothing, and taking it back returns it to the button
   * that asked.
   *
   * @param {boolean} asking
   */
  async function askCleanup(asking) {
    confirmingCleanup = asking
    await painted()
    ;(asking ? cleanupCancel : cleanupButton)?.focus()
  }

  /** Escape on the question's own buttons takes it back. */
  function onCleanupKey(event) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    askCleanup(false)
  }

  /**
   * Whether cleanup has asked its question yet.
   *
   * One press took six tasks off the board with no confirmation, while Delete —
   * which takes *one* task — sits behind a visible two-step confirm. Same
   * pattern as the modal's: the question replaces the button that raised it,
   * and it names both the count and where they are going.
   *
   * Cleared whenever the count moves, or a confirm armed against six tasks
   * could be answered about a seventh — a chip tapped in between changes what
   * the board is showing and so what cleanup takes.
   */
  let confirmingCleanup = $state(false)

  $effect(() => {
    done.length
    confirmingCleanup = false
  })

  /**
   * Whether the older archive page is out.
   *
   * The request's own state and not the view's: the rows on screen come from
   * the `archive` store and are never waiting on this, so it gates the
   * button's word and nothing else. The forbidden shape is a `loading` flag
   * that decides whether anything is *drawn*; this one starts false and the
   * column behind it stays painted throughout.
   */
  let loadingOlder = $state(false)

  /**
   * Read the archive page after the one held, on request.
   *
   * Not a `resource()`, because there is no reactive query behind it: the
   * cursor moves because somebody asked for more, and a resource watching the
   * cursor would re-read the moment its own read replaced it — the feedback
   * loop `resource()` exists to prevent, arrived at from the other side.
   *
   * `ensureArchive` appends when it is given a `before` and only marks the
   * collection fetched for a first page, so paging is a distinct read from the
   * one the view opens with.
   */
  async function showOlder() {
    const cursor = $archiveNext
    if (!cursor || loadingOlder) return
    loadingOlder = true
    try {
      await ensureArchive({ before: cursor })
    } finally {
      loadingOlder = false
    }
  }

  /**
   * Which task the modal is open on, by the identity every device agrees on.
   *
   * The id and not the row: the modal reads the task out of the store itself,
   * so a correction arriving from another device is visible in an open modal.
   * Passing the row would be handing it a snapshot.
   */
  let opened = $state(null)

  /**
   * Open the modal on a task.
   *
   * @param {object} task
   */
  function openTask(task) {
    opened = task.client_id
  }

</script>

<Frame eyebrow="What you mean to do" title="Tasks" column={COLUMN} spread={breakout}>
  <!-- The heading's line carries the one control a *tick* can call up. *Clean
       up N done* arrives with the first done task, and in the toolbar it was a
       row of its own on a phone: ticking the first task moved the whole board
       down under the finger that ticked it. Beside the `h1` it changes no row:
       a 34px button next to a 36px line adds no height, and it fits at 320 with
       room for a three-digit count. Beside the `h1` and not beside the eyebrow
       above it, because that block is as wide as its eyebrow, and at 320 the
       two came to 305px of a 296px row and the button wrapped under the heading.
       Keeping an empty place for it in the toolbar was the other structural
       answer, and on a phone that is a permanent row of chrome above every
       board. Only the confirmation a press opens may wrap. -->
  {#snippet aside()}

      <!-- The count is on the button because the pressure it relieves is
           invisible otherwise: done tasks stay in the list until somebody
           presses this, which is the rule, so the button says what it will do
           before it does it. Not offered on the archive, which is where it
           would be moving things to — and not offered here at all under the
           `list` grouping, where every list is on screen and one button could
           only be about one of them. There it is per column. -->
      {#if done.length && !byList && !showingArchive}
        <!-- Behind the same two-step confirm the modal's Delete uses. One press
             here archived six tasks; one press there takes a single task and
             still asks. The question replaces the button that raised it and
             names the count and the destination, because *Clean up 6 done* says
             neither where they go nor that they are going now. -->
        <!-- `-my-1`: the buttons are 44px and the heading's line is 36, so the
             group reaches 4px past the line each way and occupies exactly it.
             Reserving 44px on the heading row instead would move the first
             row 8px against Lists and the calendar, which have no aside. -->
        <div class="-my-1 flex flex-wrap items-stretch gap-1">
          {#if confirmingCleanup}
            <span class="meta self-center whitespace-nowrap" data-cleanup-asking>
              Archive {done.length} done {done.length === 1 ? 'task' : 'tasks'}?
            </span>
            {#each elsewhere as sentence (sentence)}
              <span class="meta self-center" data-cleanup-elsewhere>{sentence}</span>
            {/each}
            <button
              class="btn-danger meta border-ember whitespace-nowrap text-paper select-none [-webkit-touch-callout:none]"
              data-cleanup-confirm
              onkeydown={onCleanupKey}
              onclick={(event) => {
                confirmingCleanup = false
                cleanUpAndFollow(done, null, event)
              }}
            >
              Archive
            </button>
            <button
              class="btn-outline meta whitespace-nowrap select-none [-webkit-touch-callout:none]"
              bind:this={cleanupCancel}
              data-cleanup-cancel
              onkeydown={onCleanupKey}
              onclick={() => askCleanup(false)}
            >
              Cancel
            </button>
          {:else}
            <button
              class="btn-outline meta whitespace-nowrap select-none [-webkit-touch-callout:none]"
              bind:this={cleanupButton}
              data-cleanup
              onclick={() => askCleanup(true)}
            >
              Clean up {done.length} done
            </button>
          {/if}
        </div>
      {/if}
  {/snippet}

  <!-- One row for every control that changes what the board means, which is
       the smoothing-slider lesson applied before it bites: a control that is
       not on screen still applies. Each group is its own flex container, so a
       cramped row moves a whole group to the next line rather than splitting a
       label from the buttons it names.

       **Ordered from stable to conditional, so a view change moves nothing.**
       The grouping pills come first, because every view has them; the list
       selector second, because one grouping replaces it; the layout toggle last
       and anchored to the column's right edge, because only some groupings offer
       one. A control that can disappear sits after everything that cannot, and
       where one does go its *place* is kept and says why — so on a phone the
       rows below do not climb 46px either. -->
  <div class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3" data-toolbar>
    <!-- Pills, not a `<select>`. It was the only one in the four toolbars,
         beside two rows of pills that do the same kind of job, and Time
         Patterns switches five windows with five of these — which is what
         made this row read as bolted on. `data-grouping` stays on the group
         so what is *showing* is still one attribute to find; `aria-pressed`
         on each says which. Its own flex container, so at 320 it takes two
         rows rather than splitting a label off the buttons beside it.

         The archive is not grouped, so there the pills keep their exact box
         — invisible, which also takes them out of the tab order and the
         accessibility tree — under a caption saying so. Hiding them slid the
         list chips into their place the moment the Archive chip was tapped. -->
    <!-- Below 48rem, three equal cells a row and never a strip that scrolls —
         the rule the category switcher already follows. Six pills scrolled
         sideways at 320 and ended in a cut one; *Eisenhower*, the widest label,
         fits a third of the 296px row with room to spare. -->
    <div
      class="relative gap-1
             {$wide ? 'flex flex-wrap' : 'grid w-full auto-rows-fr grid-cols-3'}
             {showingArchive ? 'overflow-hidden' : ''}"
      role={showingArchive ? undefined : 'group'}
      aria-label={showingArchive ? undefined : 'Group by'}
      data-grouping={showingArchive ? undefined : ''}
      data-grouping-slot
    >
      {#each Object.values(GROUPINGS) as one (one.id)}
        <button
          class="meta rounded-md border py-2 transition select-none [-webkit-touch-callout:none]
                 {$wide ? 'shrink-0 px-3 whitespace-nowrap' : 'min-w-0 px-1 text-center break-words'}
                 {showingArchive ? 'invisible' : ''}
                 {one.id === groupingId
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          data-grouping-option={showingArchive ? undefined : one.id}
          aria-pressed={one.id === groupingId}
          onclick={() => {
            groupingId = one.id
            steered.add('grouping')
          }}
        >
          {one.label}
        </button>
      {/each}
      {#if showingArchive}
        <p
          class="meta absolute inset-y-0 left-0 flex items-center whitespace-nowrap"
          data-grouping-archive
        >
          The archive is not grouped
        </p>
      {/if}
    </div>

    <!-- A toggle each rather than a choice between them: the board shows a
         **set** of lists, and at least one of them always — tapping the last
         one selected is the one press here that does nothing, because a board
         showing no list has nothing to draw and nowhere to put a typed task.
         `aria-pressed` is what says which are in, and it is the same attribute
         a single-selection row used, so nothing reading it has to learn a
         second shape.

         **Below 48rem, equal cells that wrap**, as the pills above and the
         category switcher below: one row that scrolled sideways ended in a cut
         chip at 320, and a chip off screen is a list you cannot see is there. A
         long name wraps inside its cell rather than losing letters.

         **Under the Lists grouping the chips keep their exact box**, drawn
         invisible and without a single hook, under a caption saying why — the
         archive's rule for the pills. Every list is a column there, so a
         control choosing between them would have nothing to do; but a one-line
         caption in place of two rows of cells moved the board up by a row on a
         phone the moment the grouping changed. `invisible` also takes the cells
         out of the tab order and the accessibility tree. -->
    <div
      class="relative gap-1
             {$wide
        ? 'flex flex-wrap'
        : 'grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]'}"
      role={byList ? undefined : 'group'}
      aria-label={byList ? undefined : 'Lists'}
      data-list-chips={byList ? undefined : ''}
      data-list-slot
    >
      {#if several || chips.filter((one) => one.kind !== 'archive').length > 1}
        <!-- Only where there is more than one ordinary list to gather, or it
             is a control whose whole effect is already on screen. -->
        <button
          class="meta rounded-md border py-2 transition select-none [-webkit-touch-callout:none]
                 {$wide ? 'shrink-0 px-3 whitespace-nowrap' : 'min-w-0 px-1 text-center'}
                 {byList ? 'invisible' : ''}
                 {allSelected && !byList
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          data-list-all={byList ? undefined : ''}
          aria-pressed={byList ? undefined : allSelected}
          onclick={selectAll}
        >
          All
        </button>
      {/if}
      {#each chips as one (one.id)}
        <button
          class="meta flex items-center gap-2 rounded-md border py-2 transition select-none [-webkit-touch-callout:none]
                 {$wide ? 'shrink-0 px-3 whitespace-nowrap' : 'relative min-w-0 justify-center px-1'}
                 {byList ? 'invisible' : ''}
                 {listIds.includes(one.id) && !byList
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          data-list={byList ? undefined : one.id}
          data-kind={byList ? undefined : one.kind}
          aria-pressed={byList ? undefined : listIds.includes(one.id)}
          onclick={() => toggleList(one)}
        >
          <!-- Below 48rem the dot sits in the cell's corner rather than beside
               the label, and the label never breaks inside a word. Beside it,
               the dot and its gap took 16px of a 90px cell at 390, and
               *Groceries* split as "GROCERIE / S" through `break-words`. In the
               corner the label has the whole cell: 82px there for a 67.5px
               word, which is the 15% a phone's wider monospace needs. -->
          <span
            class="{$wide ? 'size-2 shrink-0' : 'absolute top-1 left-1 size-1.5'} rounded-full"
            style:background={chipColour(one.colour)}
            aria-hidden="true"
          ></span>
          <span class="min-w-0 text-center [overflow-wrap:normal]" data-chip-label>{one.name}</span>
        </button>
      {/each}
      {#if byList}
        <p
          class="meta absolute inset-y-0 left-0 flex items-center whitespace-nowrap"
          data-list-columns
        >
          Every list is a column
        </p>
      {/if}
    </div>

    {#if choosable && !showingArchive}
      <!-- Only where there is a choice *and* room for one. Below 48rem a
           column layout is the pager, which is not a third option somebody
           picks — it is what `columns` and `quadrants` are on a phone.
           `ml-auto` pins it to the frame's right edge, so appearing moves
           nothing to its left and nothing to its left moves it. -->
      <div class="ml-auto flex items-stretch gap-1" role="group" aria-label="Layout">
        {#each grouping.layouts as one (one)}
          <button
            class="meta rounded-md border px-3 py-2 whitespace-nowrap transition select-none [-webkit-touch-callout:none]
                   {one === layout
              ? 'border-ember bg-ember/10 text-paper'
              : 'border-white/15 hover:border-white/40'}"
            data-layout={one}
            aria-pressed={one === layout}
            onclick={() => {
              layoutId = one
              steered.add('layout')
            }}
          >
            {one === 'stacked' ? 'Stacked' : one === 'columns' ? 'Columns' : 'Quadrants'}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#snippet board()}
  {#if loading}
    <p class="meta">Loading your tasks…</p>
  {:else if !lists.length}
    <p class="text-sm text-haze">
      No lists yet. Connect once to create them.
    </p>
  {:else}
    <Board
      grouping={grouping.id}
      {columns}
      {today}
      {lists}
      {listsById}
      layout={arrangement}
      {into}
      showList={showingArchive || (several && !byList)}
      me={username}
      readOnly={showingArchive}
      drag={showingArchive ? null : drag}
      menu={showingArchive ? null : menu}
      onadd={add}
      ontoggle={toggle}
      onopen={openTask}
      onnudge={nudge}
      oncleanup={byList
        ? (column, event) =>
            cleanUpAndFollow(column.tasks.filter((row) => row.done_at), column.id, event)
        : null}
      onsweep={sweepAndFollow}
      onolder={showOlder}
      {loadingOlder}
    />
  {/if}
  {/snippet}

  <!-- The keyboard's only feedback. `aria-live` rather than a toast: it is
       about a card that has already moved, and a reader who can see it move
       does not need telling. -->
  <p class="sr-only" role="status" aria-live="polite" data-moved>{moved}</p>
</Frame>

<!-- Outside the section, because it is positioned against the *viewport*: a
     card sits inside a column that hides its own overflow, and the edges are
     exactly where a right-click is most often aimed. -->
<TaskMenu {menu} />

{#if opened}
  <!-- Keyed on the identity, so opening a second task replaces the first
       rather than stacking. Inside the page rather than at the document root:
       a `<dialog>` in the top layer still inherits the custom properties of its
       DOM parent, which is what keeps the section's own accent on it. -->
  <TaskModal clientId={opened} onclose={() => (opened = null)} />
{/if}
