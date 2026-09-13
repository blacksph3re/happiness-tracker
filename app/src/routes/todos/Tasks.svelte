<script>
  import { tick as painted, untrack } from 'svelte'

  import Board from '../../lib/todos/Board.svelte'
  import TaskMenu from '../../lib/todos/TaskMenu.svelte'
  import TaskModal from '../../lib/todos/TaskModal.svelte'
  import { tick, untick } from '../../lib/todos/fields.js'
  import { markTicked } from '../../lib/todos/tick.js'
  import { GROUPINGS, groupingFor, listOrder } from '../../lib/todos/groupings.js'
  import { selectedLists, storedLists, todoSettings } from '../../lib/todo-settings.js'
  import { cardDrag } from '../../lib/todos/drag.svelte.js'
  import { taskMenu } from '../../lib/todos/task-menu.svelte.js'
  import { between, compareRank, needsRebalance, spread } from '../../lib/todos/rank.js'
  import { dayLabel, today as todayKey } from '../../lib/day.js'
  import { chipColour } from '../../lib/palette.js'
  import { wide } from '../../lib/media.js'
  import { resource } from '../../lib/resource.svelte.js'
  import {
    archive,
    archiveListId,
    archiveNext,
    ensureArchive,
    ensurePomodoros,
    ensurePreferences,
    ensureTodoLists,
    ensureTodos,
    me,
    persistPreferences,
    preferenceSection,
    preferences,
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
  let groupingId = $state('date')
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
   * How wide the page's regions are, and where they start.
   *
   * **One value for the heading, the toolbar and the board**, because they have
   * to share a left edge: `columns` lays out from a per-column minimum, so its
   * width is decided by the grouping rather than by the screen — five columns
   * came to 1216px inside the 1112 the reading width left, clipped identically
   * at 1280, 1440 and 1920. It gets the whole page there, and a centred heading
   * above a full-width board sat 384px right of the first column, which reads
   * as two pages. A stack and a 2×2 grid are decided by the screen and keep the
   * reading width, where a card 1,880px wide is a line nobody can follow.
   */
  const region = $derived(
    layout === 'columns' ? 'w-full px-5' : 'mx-auto w-full max-w-6xl px-5'
  )

  // The archive is the one collection that is paged and the one that is not in
  // the snapshot: it is read when it is looked at, and not before. Two views
  // look at it — the archive chip, and the `list` grouping, where it is a
  // column like any other. The loader writes only `archive`, so there is
  // nothing here to feed back.
  const archiveLoad = resource(
    () => showingArchive || byList,
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
            tasks: tasks.toSorted((a, b) =>
              (b.archived_at ?? '9999').localeCompare(a.archived_at ?? '9999')
            ),
          },
        ]
      : grouping.columns(tasks, today, settings, lists).map((column, _, all) => ({
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

  /** Put the board back on the lists, grouping and layout it was last left on. */
  async function restore() {
    const stored = preferenceSection(await ensurePreferences(), 'todos')
    if (!steered.has('lists')) chosen = storedLists(stored)
    if (!steered.has('grouping') && GROUPINGS[stored.grouping]) groupingId = stored.grouping
    if (!steered.has('layout') && typeof stored.layout === 'string') layoutId = stored.layout
    restored = true
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
   *   whether anything happened — and awaitable for the one caller that has to
   *   know *when* it did: the keyboard puts the focus back on a card the store
   *   update re-creates, and it cannot aim at an element that does not exist.
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
    const at = Math.min(Math.max(index, 0), others.length)
    const was = column.tasks.findIndex((row) => row.client_id === task.client_id)
    const patch = grouping.drop(task, column.id, today, settings, lists)

    // Dropped back where it came from: no field to change and the same
    // neighbours either side. Writing anyway would queue an intent that says
    // nothing, and on a slow connection that is a write somebody waits for.
    if (!Object.keys(patch).length && was === at) return false

    const rank = between(others[at - 1]?.rank ?? null, others[at]?.rank ?? null)
    const moved = { ...task, ...patch, rank }

    if (!needsRebalance(rank)) {
      return saveTodo(moved)
    }

    // The key this drop would need has grown far enough to be silly, so the
    // drop re-ranks its own column instead — one batch, short keys, and the
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
    let last = staying.at(-1)?.rank ?? null
    const moved = moving.map((task) => {
      const rank = between(last, null)
      last = rank
      return { ...task, ...grouping.drop(task, target.id, today, settings, lists), rank }
    })
    if (!moved.some((row) => needsRebalance(row.rank))) return saveTodos(moved)
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
   * Move a card with the keyboard: along its column, or into the next one.
   *
   * Sideways is the one gesture that cannot name a place, so it lands at the
   * **same index** in the neighbouring column, clamped to its length — which is
   * as close to *where it was* as a keyboard can be. Along the column is a rank
   * change and nothing else, exactly as an in-column drag is.
   *
   * @param {object} task
   * @param {string} columnId The column the card is in now.
   * @param {number} dx `-1` or `1` to move across, `0` to stay.
   * @param {number} dy `-1` or `1` to move along, `0` to stay.
   */
  function nudge(task, columnId, dx, dy) {
    if (showingArchive) return
    const from = columns.findIndex((one) => one.id === columnId)
    const column = columns[from]
    if (!column) return

    if (dy) {
      const spot = column.tasks.findIndex((row) => row.client_id === task.client_id)
      const to = spot + dy
      // Refused rather than clamped: a card at the top asked to go up has
      // nowhere to go, and writing a rank that changes nothing would queue an
      // intent saying nothing.
      if (spot < 0 || to < 0 || to >= column.tasks.length) return
      const written = place(task, column, to)
      if (written) {
        announce(`Moved within ${column.label}, position ${to + 1}`)
        keepFocus(task.client_id, written)
      }
      return
    }

    const target = columns[from + dx]
    if (!target) return
    const spot = column.tasks.findIndex((row) => row.client_id === task.client_id)
    const to = Math.min(Math.max(spot, 0), target.tasks.length)
    const written = place(task, target, to)
    if (written) {
      announce(`Moved to ${target.label}, position ${to + 1}`)
      keepFocus(task.client_id, written)
    }
  }

  /**
   * Put the focus back on a card the write has just re-created.
   *
   * **Without this the keyboard gives you exactly one move.** A card moved
   * along its column keeps its element — Svelte moves a node whose key it still
   * sees — but one moved *across* leaves the source column's `{#each}` and is
   * built afresh in the target's, so the element the focus was on no longer
   * exists and the focus falls to `<body>`. The next arrow then does nothing
   * and you have to Tab back in, in the path the plan calls the version of this
   * gesture that works.
   *
   * **The write is awaited and not a tick guessed after it.** `saveTodo`
   * resolves once the intent is durable *and* the store has been told, so this
   * is the one honest moment to look for the new element: a bare `await tick()`
   * finds the card still where it was, leaves the focus alone because it is
   * already on it, and loses it a microtask later when the projection lands.
   *
   * Silent when there is nothing to focus: a sideways move in the pager lands
   * the card in a column that is not on screen, and there is genuinely no
   * element to put the focus on.
   *
   * @param {string} clientId The moved task's identity.
   * @param {Promise<unknown>} written The write `place` returned.
   */
  async function keepFocus(clientId, written) {
    // A refused intent is reported by the toast the drain raises; here it only
    // means there is no card to aim at.
    await Promise.resolve(written).catch(() => {})
    await painted()
    const card = document.querySelector(`article[data-client-id="${clientId}"]`)
    if (card instanceof HTMLElement && card !== document.activeElement) card.focus()
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
    const last = column.tasks.toSorted(compareRank).at(-1)
    saveTodo({
      list_id: creating.id,
      title,
      ...fields,
      rank: between(last?.rank ?? null, null),
    })
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
    if (!into || !rows.length) return
    saveTodos(rows.map((row) => ({ ...row, list_id: into })))
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

<!-- The page's own gutter, with the *reading* width applied per region rather
     than to the whole section. The heading and the toolbar are prose and keep
     it; the board does not, and bounding it there is what clipped a
     five-column layout at every desktop width — see the board region below. -->
<section class="w-full py-8">
  <!-- The gutter lives on each region rather than on the section, so the
       reading width is the same 1112px it always was: moved outwards it became
       1152 and shifted the whole board 20px left, which a carry test measured
       within one run. -->
  <div class={region}>
  <div class="mb-6">
    <p class="meta">What you mean to do</p>
    <h1 class="mt-1 text-3xl font-bold tracking-tight">Tasks</h1>
  </div>

  <!-- One row for every control that changes what the board means, which is
       the smoothing-slider lesson applied before it bites: a control that is
       not on screen still applies. Each group is its own flex container, so a
       cramped row moves a whole group to the next line rather than splitting a
       label from the buttons it names. -->
  <div class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
    {#if !byList}
      <!-- A toggle each rather than a choice between them: the board shows a
           **set** of lists, and at least one of them always — tapping the last
           one selected is the one press here that does nothing, because a board
           showing no list has nothing to draw and nowhere to put a typed task.
           `aria-pressed` is what says which are in, and it is the same
           attribute a single-selection row used, so nothing reading it has to
           learn a second shape. -->
      <!-- **One row that scrolls below 48rem**, rather than a block that wraps.
           Measured at 390: five lists took two rows of chips and the first card
           began at y=414 of 844, over half the screen spent on chrome. Every
           chip is still here and still a toggle - a summary that opened a sheet
           would have cost a tap to reach the thing a tap already does. -->
      <div
        class={$wide
          ? 'flex flex-wrap gap-1'
          : '-mx-5 flex gap-1 overflow-x-auto px-5'}
        role="group"
        aria-label="Lists"
        data-list-chips
      >
        {#if several || chips.filter((one) => one.kind !== 'archive').length > 1}
          <!-- Only where there is more than one ordinary list to gather, or it
               is a control whose whole effect is already on screen. -->
          <button
            class="meta shrink-0 rounded-md border px-3 py-2 whitespace-nowrap transition
                   {allSelected
              ? 'border-ember bg-ember/10 text-paper'
              : 'border-white/15 hover:border-white/40'}"
            data-list-all
            aria-pressed={allSelected}
            onclick={selectAll}
          >
            All
          </button>
        {/if}
        {#each chips as one (one.id)}
          <button
            class="meta flex shrink-0 items-center gap-2 rounded-md border px-3 py-2
                   whitespace-nowrap transition
                   {listIds.includes(one.id)
              ? 'border-ember bg-ember/10 text-paper'
              : 'border-white/15 hover:border-white/40'}"
            data-list={one.id}
            data-kind={one.kind}
            aria-pressed={listIds.includes(one.id)}
            onclick={() => toggleList(one)}
          >
            <span
              class="size-2 rounded-full"
              style:background={chipColour(one.colour)}
              aria-hidden="true"
            ></span>
            {one.name}
          </button>
        {/each}
      </div>
    {/if}

    {#if !showingArchive}
      <!-- Pills, not a `<select>`. It was the only one in the four toolbars,
           beside two rows of pills that do the same kind of job, and Time
           Patterns switches five windows with five of these — which is what
           made this row read as bolted on. `data-grouping` stays on the group
           so what is *showing* is still one attribute to find; `aria-pressed`
           on each says which. Its own flex container, so at 320 it takes two
           rows rather than splitting a label off the buttons beside it. -->
      <div
        class={$wide
          ? 'flex flex-wrap gap-1'
          : '-mx-5 flex gap-1 overflow-x-auto px-5'}
        role="group"
        aria-label="Group by"
        data-grouping
      >
        {#each Object.values(GROUPINGS) as one (one.id)}
          <button
            class="meta shrink-0 rounded-md border px-3 py-2 whitespace-nowrap transition
                   {one.id === groupingId
              ? 'border-ember bg-ember/10 text-paper'
              : 'border-white/15 hover:border-white/40'}"
            data-grouping-option={one.id}
            aria-pressed={one.id === groupingId}
            onclick={() => {
              groupingId = one.id
              steered.add('grouping')
            }}
          >
            {one.label}
          </button>
        {/each}
      </div>

      {#if choosable}
        <!-- Only where there is a choice *and* room for one. Below 48rem a
             column layout is the pager, which is not a third option somebody
             picks — it is what `columns` and `quadrants` are on a phone. -->
        <div class="flex items-stretch gap-1" role="group" aria-label="Layout">
          {#each grouping.layouts as one (one)}
            <button
              class="meta rounded-md border px-3 py-2 whitespace-nowrap transition
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

      <!-- The count is on the button because the pressure it relieves is
           invisible otherwise: done tasks stay in the list until somebody
           presses this, which is the rule, so the button says what it will do
           before it does it. Not offered on the archive, which is where it
           would be moving things to — and not offered here at all under the
           `list` grouping, where every list is on screen and one button could
           only be about one of them. There it is per column. -->
      {#if done.length && !byList}
        <!-- Behind the same two-step confirm the modal's Delete uses. One press
             here archived six tasks; one press there takes a single task and
             still asks. The question replaces the button that raised it and
             names the count and the destination, because *Clean up 6 done* says
             neither where they go nor that they are going now. -->
        <div class="flex flex-wrap items-stretch gap-1">
          {#if confirmingCleanup}
            <span class="meta self-center whitespace-nowrap" data-cleanup-asking>
              Archive {done.length} done {done.length === 1 ? 'task' : 'tasks'}?
            </span>
            {#each elsewhere as sentence (sentence)}
              <span class="meta self-center" data-cleanup-elsewhere>{sentence}</span>
            {/each}
            <button
              class="meta rounded-md border border-ember px-3 py-2 whitespace-nowrap
                     text-paper transition hover:bg-ember/10"
              data-cleanup-confirm
              onclick={() => {
                confirmingCleanup = false
                cleanUp(done)
              }}
            >
              Archive
            </button>
            <button
              class="meta rounded-md border border-white/20 px-3 py-2 whitespace-nowrap
                     hover:border-white/40"
              data-cleanup-cancel
              onclick={() => (confirmingCleanup = false)}
            >
              Cancel
            </button>
          {:else}
            <button
              class="meta rounded-md border border-white/15 px-3 py-2 whitespace-nowrap
                     hover:border-white/40"
              data-cleanup
              onclick={() => (confirmingCleanup = true)}
            >
              Clean up {done.length} done
            </button>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  </div>

  <!-- The board's own region, on the same `region` the heading above it uses:
       see the note on that derived value for why the width is the point and
       why the two must not disagree. -->
  <div class={region}>
  {#if loading}
    <p class="meta">Loading your tasks…</p>
  {:else if !lists.length}
    <p class="text-sm text-haze">
      This account has no lists yet. They are made on the server, so this needs a
      connection once.
    </p>
  {:else}
    <Board
      {columns}
      {today}
      {lists}
      {listsById}
      {layout}
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
      oncleanup={byList ? (column) => cleanUp(column.tasks.filter((row) => row.done_at)) : null}
      onsweep={sweep}
      onolder={showOlder}
      {loadingOlder}
    />
  {/if}
  </div>

  <!-- The keyboard's only feedback. `aria-live` rather than a toast: it is
       about a card that has already moved, and a reader who can see it move
       does not need telling. -->
  <p class="sr-only" role="status" aria-live="polite" data-moved>{moved}</p>
</section>

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
