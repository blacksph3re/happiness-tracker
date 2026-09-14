<script>
  import { untrack } from 'svelte'
  import { get } from 'svelte/store'

  import CalendarBody from '../../lib/todos/Calendar.svelte'
  import Frame from '../../lib/todos/Frame.svelte'
  import TaskMenu from '../../lib/todos/TaskMenu.svelte'
  import { taskMenu } from '../../lib/todos/task-menu.svelte.js'
  import TaskModal from '../../lib/todos/TaskModal.svelte'
  import { today as todayKey } from '../../lib/day.js'
  import { DEFAULT_MINUTES, clockOfMinutes } from '../../lib/todos/calendar.js'
  import { wallClock } from '../../lib/todos/fields.js'
  import { resource } from '../../lib/resource.svelte.js'
  import {
    ensurePomodoros,
    ensurePreferences,
    ensureTodoLists,
    ensureTodos,
    inboxList,
    persistPreferences,
    preferenceSection,
    preferences,
    ready,
    saveTodo,
    settleActiveTasks,
    todoLists,
    todos as todoStore,
  } from '../../lib/store.js'

  /**
   * The calendar page: the week strip, a day or a week of hours, and the modal.
   *
   * Everything drawn comes out of the stores and nothing is snapshotted into
   * local state, which is the rule rather than a preference: a task corrected
   * on another device arrives by a read replacing the store, and a page holding
   * its own copy could not see it. The two controls and the selected day are
   * the only state here, and two of the three are remembered per account.
   *
   * **The calendar shows every list at once**, unlike the board, which is one
   * list at a time. A day has one clock however many lists the work is filed
   * under, so hiding some of it would draw a day with gaps in it that were not
   * free — and the block's colour is what says which list it came from, which
   * is why the page passes the lists down rather than a chip row.
   */

  const today = todayKey()

  /** Which day the strip has selected. Not remembered: a calendar opens on today. */
  let selected = $state(today)

  /** @type {'day' | 'week'} */
  let mode = $state('week')
  let showDue = $state(false)

  /** Whether the saved view has been read, so mirroring it back is not a save. */
  let restored = $state(false)

  /**
   * Which controls the reader has already moved, so the restore leaves them.
   *
   * The same guard `openBands` needs, and the rule `ensurePreferences` follows
   * one level along: **a choice made while the read is outstanding is a real
   * choice.** `restore` assigns after an await, so a toggle checked in that
   * window was being unchecked by the stored value landing on top of it —
   * reproduced deterministically by delaying `GET /api/me/preferences` and
   * checking the box, and it is what made a calendar test fail about once per
   * full suite run. Per control rather than one flag for the page: touching the
   * toggle must not also cost a remembered Day mode.
   *
   * Not `$state`: it is read once, after an await, by code that must not
   * re-run because of it.
   */
  const steered = new Set()

  // A constant query: nothing on this page is read by day, so moving the strip
  // re-fetches nothing and arriving here a second time paints from the store.
  // `revalidate.js` is what asks the server whether anything moved.
  const loaded = resource(
    () => 'todos',
    async () => {
      const held = await Promise.all([
        ensureTodos(),
        ensureTodoLists(),
        ensurePreferences(),
        // Not drawn here either — see the board. Start a pomodoro has to know
        // whether one is running, and it reads that from the store.
        ensurePomodoros({ start: today, end: today }),
      ])
      await settleActiveTasks()
      return held
    },
    { name: 'todo calendar' }
  )

  const tasks = $derived($todoStore ?? [])
  const lists = $derived($todoLists ?? [])
  const listsById = $derived(Object.fromEntries(lists.map((one) => [one.id, one])))

  /** Where a task made by tapping empty space lands, as everywhere else. */
  const inbox = $derived($inboxList)

  /** Only true while there is genuinely nothing to draw — never "a request is out". */
  const loading = $derived(loaded.loading && tasks.length === 0)

  // Nothing reactive is read before the first await, so this effect has no
  // dependencies and runs once — the shape that cannot re-trigger itself.
  $effect(() => {
    restore()
  })

  /**
   * Put the page back on the mode and the toggle it was last left on.
   *
   * **From the snapshot first, and then from the read**, as the board does.
   * `ensurePreferences` waits on the network on every reload, so applying only
   * its answer painted a remembered Day as Week for as long as the connection
   * took, over a snapshot that already knew. The confirmed read still lands on
   * top, so another device's change arrives; saving waits for it as before.
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
    if (
      !steered.has('calendar_mode') &&
      (stored.calendar_mode === 'day' || stored.calendar_mode === 'week')
    ) {
      mode = stored.calendar_mode
    }
    if (!steered.has('calendar_due')) showDue = Boolean(stored.calendar_due)
  }

  $effect(() => {
    // Reading them here is what subscribes this effect to both controls. The
    // store drops a save that matches what is stored, so arriving on a
    // remembered view writes nothing.
    const view = { calendar_mode: mode, calendar_due: showDue }
    if (!restored) return
    // **`untrack`, and it is not a precaution.** `persistPreferences` replaces
    // the named section, so this page has to carry the board's `list`,
    // `grouping`, `layout` and `settings` through or switching to Week would
    // delete them — and reading them from `$preferences` *tracked* makes this
    // an effect that reads what it writes, which does not throw: the write
    // lands after an await, so Svelte's depth counter has reset by the time it
    // arrives and the effect loops for ever with nothing said about it.
    //
    // Read here rather than snapshotted at `restore` time, which is what it
    // used to be: a snapshot cannot see a key the board wrote afterwards, and
    // this page outlives a walk over to the board and back.
    const stored = untrack(() => preferenceSection($preferences, 'todos'))
    persistPreferences('todos', { ...stored, ...view })
  })

  /**
   * Which task the modal is open on, by the identity every device agrees on.
   *
   * The id and not the row: the modal reads the task out of the store itself,
   * so a correction arriving from another device is visible in an open modal.
   */
  let opened = $state(null)

  /**
   * The right-click menu over the blocks.
   *
   * Made here because it is drawn here — positioned against the viewport, and
   * so outside the section that scrolls the hours — while the drag whose carry
   * a long press cancels lives inside the body that owns the grid. The two are
   * introduced there, through `menu.oncarry`.
   */
  const menu = taskMenu()

  /**
   * Create a task where the calendar was tapped, then open it.
   *
   * `TaskModal` has no create mode — it takes a `clientId` and reads the row
   * from the store — so the only way to open the modal on a new task is to
   * write one first. That is also the honest order: the task exists on the
   * device the moment it is asked for, so a modal closed with `Escape` leaves a
   * task called *New task* rather than losing the gesture. Delete is in the
   * modal, which is where getting rid of it belongs.
   *
   * The modal focuses the dialog rather than the title field — deliberately, so
   * that opening a task to read it does not put a caret in its name — so the
   * placeholder is replaced by tapping the title. That is the modal's decision
   * and not this page's to override.
   *
   * @param {{day: string, hour: number|null}} where The day tapped, and the
   *   hour when the tap was in the grid rather than in the anytime row.
   */
  async function add({ day, hour }) {
    if (!inbox) return
    opened = await saveTodo({
      list_id: inbox.id,
      title: 'New task',
      planned_on: day,
      // A whole hour, because that is all a tap on an hour row can mean. Null
      // is the anytime row, which is a plan with no time rather than midnight.
      planned_at: hour === null ? null : `${String(hour).padStart(2, '0')}:00`,
    })
  }

  /**
   * Move a task to a day and a time, which is the whole of what a drop means.
   *
   * Two fields and nothing else. `saveTodo` sends the row it is given, so
   * spreading the task carries every other field through unchanged — the
   * duration a block was drawn with is not the drag's business, and neither is
   * the rank, the tick or the list.
   *
   * **A drop back where it came from writes nothing.** The comparison is here
   * rather than in the picture because this is the side that knows what is
   * stored: `planned_at` comes back from the server as `HH:MM:SS` and is
   * written as `HH:MM`, so the two are compared through `wallClock` or every
   * drop onto its own slot would look like a change. On a slow connection an
   * intent that says nothing is still something somebody waits for.
   *
   * @param {object} task The task as the store holds it.
   * @param {{day: string, minutes: number|null}} to The day, and minutes since
   *   midnight or null for the anytime row.
   * @returns {Promise<boolean>} Whether anything was written.
   */
  async function move(task, { day, minutes }) {
    const planned_at = minutes === null ? null : clockOfMinutes(minutes)
    if (task.planned_on === day && wallClock(task.planned_at) === planned_at) return false
    await saveTodo({ ...task, planned_on: day, planned_at })
    return true
  }

  /**
   * Set a task's estimate, which is what the height of its block means.
   *
   * One field and nothing else, the same shape `move` has: `saveTodo` sends the
   * row it is given, so spreading the task carries the day, the time, the rank
   * and the tick through untouched.
   *
   * **A resize back to the size it was writes nothing.** Compared against the
   * *drawn* size rather than the stored value, which is the one that matters
   * here and is not the same thing: a task with no estimate is drawn at
   * `DEFAULT_MINUTES`, so a drag that ends where it started on one of those
   * would otherwise store half an hour nobody asked for — an estimate invented
   * by a gesture that said nothing.
   *
   * @param {object} task The task as the store holds it.
   * @param {number} minutes The estimate the gesture landed on.
   * @returns {Promise<boolean>} Whether anything was written.
   */
  async function resize(task, minutes) {
    if ((task.duration_minutes ?? DEFAULT_MINUTES) === minutes) return false
    await saveTodo({ ...task, duration_minutes: minutes })
    return true
  }

</script>

<Frame eyebrow="Tasks on a clock" title="Calendar">

  <!-- One row for both controls, above the picture they change — the same
       reason the board's toolbar is one row: a control that decides what is on
       screen belongs where it can be seen from. -->
  <div class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
    <div class="flex gap-1" role="group" aria-label="Span">
      {#each [['day', 'Day'], ['week', 'Week']] as [id, label] (id)}
        <button
          class="meta rounded-md border px-3 py-2 transition
                 {mode === id
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          data-mode={id}
          aria-pressed={mode === id}
          onclick={() => {
            mode = id
            steered.add('calendar_mode')
          }}
        >
          {label}
        </button>
      {/each}
    </div>

    <label class="flex items-center gap-2">
      <input
        type="checkbox"
        class="size-4 rounded border-white/20 bg-ink-soft"
        data-due-toggle
        bind:checked={showDue}
        onchange={() => steered.add('calendar_due')}
      />
      <span class="meta">Show due dates</span>
    </label>
  </div>

  {#if loading}
    <p class="meta">Loading your tasks…</p>
  {:else if !lists.length}
    <p class="text-sm text-haze">
      This account has no lists yet. They are made on the server, so this needs a
      connection once.
    </p>
  {:else}
    <CalendarBody
      {tasks}
      {today}
      {selected}
      {mode}
      {showDue}
      {listsById}
      {menu}
      onselect={(day) => (selected = day)}
      onopen={(task) => (opened = task.client_id)}
      onadd={add}
      onmove={move}
      onresize={resize}
    />
  {/if}
</Frame>

<!-- Positioned against the viewport, so it is drawn outside the section that
     scrolls the hours. -->
<TaskMenu {menu} />

{#if opened}
  <!-- Keyed on the identity, so opening a second task replaces the first
       rather than stacking. Inside the page rather than at the document root: a
       `<dialog>` in the top layer still inherits the custom properties of its
       DOM parent, which is what keeps the section's own accent on it. -->
  <TaskModal clientId={opened} onclose={() => (opened = null)} />
{/if}
