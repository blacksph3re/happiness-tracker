<script>
  import { pushToast } from '../toasts.js'
  import { archiveList, archiveListId, saveTodo, todoLists } from '../store.js'
  import { chipColour } from '../palette.js'
  import { abandon } from './fields.js'
  import { listOrder } from './groupings.js'
  import { startFocus } from './start-focus.js'

  /**
   * Three verbs on one task, wherever a task is drawn.
   *
   * A right-click on a card is the gesture that asks for the things a card has
   * no room to offer, and the same three make sense over a calendar block — so
   * the menu is one component and `task-menu.svelte.js` is one machine, opened
   * from both. The board and the calendar each own their own, because each owns
   * the drag whose carry a long press has to cancel.
   *
   * The verbs are the *existing* helpers and never second spellings of them:
   * `abandon` from `fields.js` is what *won't do* means everywhere, and
   * starting a pomodoro is `start-focus.js`, which the modal's button calls
   * too — start, then open the timer. Which pomodoro is running is
   * `lib/pomodoro/derive.js`'s rule, this half may not read it, and so the
   * offer says what the press *does* rather than hiding itself.
   *
   * **Never off the screen**, in either direction, and the browser does the
   * arithmetic. A percentage inside a transform resolves against the element's
   * own box, so `clamp(…, calc(room - 100%), 0px)` is negative by exactly the
   * overflow and zero when there is none — which is `PointerLabel.svelte`'s
   * trick applied to both axes, and it is what keeps a measurement out of
   * state. Measuring into state works and puts the menu at an unclamped
   * position for the one frame before the measurement lands, which is a
   * transient a test can read and be right about the wrong thing.
   */
  let {
    /** The machine from `taskMenu()`, whose `shown` decides everything here. */
    menu,
  } = $props()

  /** Never flush against the edge of the screen. */
  const EDGE = 8

  /** Whether the list step is the one being drawn. */
  let choosingList = $state(false)

  const task = $derived(menu.shown?.task ?? null)

  /**
   * Every list a task can be sent to: the archive is not one of them.
   *
   * *Won't do* is what moving a task into the archive means, and it is already
   * the first verb — offering the same move twice under two names is how one
   * gesture comes to have two spellings. The list a task is already in stays on
   * the row so the set does not change under a finger, and choosing it writes
   * nothing.
   */
  const options = $derived(
    listOrder($todoLists ?? []).filter((one) => one.id !== archiveListId())
  )

  /** The menu's own element, so the keyboard lands inside it rather than behind it. */
  let node = $state(null)

  // Opening from the keyboard moves the focus in, which is what makes that path
  // a path rather than an announcement — and only from the keyboard: a
  // right-click leaves the focus where it was. `preventScroll`, because the
  // browser's own scroll-into-view fires a `scroll`, and a scroll is one of the
  // three things that dismiss this menu. Reads `menu.shown` and writes only the
  // document's focus and the step, neither of which anything here derives from.
  $effect(() => {
    if (!menu.shown) {
      choosingList = false
      return
    }
    if (menu.shown.focus) node?.querySelector('button')?.focus({ preventScroll: true })
  })

  /**
   * Close, having done the thing.
   *
   * @param {string} said What to say, or an empty string to say nothing.
   */
  function done(said) {
    if (said) pushToast(said, 'ok')
    menu.close()
  }

  /**
   * Give up on the task: the archive, and nothing else.
   *
   * The same helper the modal's *Won't do* calls, so an active task is banked
   * here exactly as it is there. Named from the list row and never from the
   * word "Archive", which is renameable.
   */
  async function wontDo() {
    const into = archiveListId()
    if (!into || !task) return
    await saveTodo(abandon(task, into))
    done(`Moved to ${$archiveList?.name ?? 'the archive'}`)
  }

  /**
   * Send the task to a list.
   *
   * A gesture that moves a row out of the list being looked at owes a toast
   * naming where it went — which is the same debt *won't do* pays.
   *
   * @param {{id: number, name: string}} list
   */
  async function sendTo(list) {
    if (!task) return
    // The list it is already in: no field to change, and a write saying nothing
    // is a write somebody waits for on a slow connection.
    if (list.id === task.list_id) {
      menu.close()
      return
    }
    await saveTodo({ ...task, list_id: list.id })
    done(`Moved to ${list.name}`)
  }

  /**
   * Start a pomodoro on the task and go to the timer.
   *
   * Closed first, holding the task: the press navigates away, and a menu left
   * open on a page being torn down is a menu nothing will close.
   */
  async function startPomodoro() {
    if (!task) return
    const held = task
    menu.close()
    await startFocus(held)
  }

  /**
   * Where the menu sits, clamped to the screen on both axes.
   *
   * Vertically a menu near the foot of the screen opens *upwards*: the same
   * clamp, so it rises by exactly the overflow and by nothing at all when
   * there is none.
   *
   * @param {number} x
   * @param {number} y
   */
  function place(x, y) {
    const right = `calc(100vw - ${EDGE + x}px - 100%)`
    const down = `calc(100vh - ${EDGE + y}px - 100%)`
    return `translate(clamp(${EDGE - x}px, ${right}, 0px), clamp(${EDGE - y}px, ${down}, 0px))`
  }
</script>

{#if menu.shown && task}
  <!-- `position: fixed`, because a card sits inside a column that hides its own
       overflow and the edges are exactly where a menu is most often asked for.
       Not a `<dialog>`: this is not modal, the page behind it stays live, and
       the browser's top layer would take the section's own accent with it. -->
  <div
    bind:this={node}
    data-task-menu
    role="group"
    aria-label={`Actions for ${task.title}`}
    class="fixed z-50 w-56 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border
           border-white/15 bg-ink shadow-2xl shadow-black/50"
    style:left="{menu.shown.x}px"
    style:top="{menu.shown.y}px"
    style:transform={place(menu.shown.x, menu.shown.y)}
  >
    <!-- Every row below is `min-h-11` — 44px — rather than padded to it, which
         is the lesson one section along: equal padding does not make equal
         buttons, because the contents decide. `py-3` on `text-sm` measured 42.
         The header is not a control and keeps its own height. -->
    <p class="meta truncate border-b border-white/10 px-3 py-2" data-menu-task>
      {task.title}
    </p>

    {#if choosingList}
      <div class="flex max-h-64 flex-col overflow-y-auto py-1">
        {#each options as one (one.id)}
          <button
            data-menu-list={one.id}
            aria-current={one.id === task.list_id ? 'true' : undefined}
            class="flex min-h-11 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-dusk/20"
            onclick={() => sendTo(one)}
          >
            <span
              class="size-2 shrink-0 rounded-full"
              style:background={chipColour(one.colour)}
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 truncate">{one.name}</span>
            {#if one.id === task.list_id}
              <span class="meta shrink-0 text-haze">here</span>
            {/if}
          </button>
        {/each}
      </div>
      <button
        data-menu-back
        class="meta flex min-h-11 w-full items-center border-t border-white/10 px-3 py-2
               text-left hover:bg-dusk/20"
        onclick={() => (choosingList = false)}
      >
        ← Back
      </button>
    {:else}
      <div class="flex flex-col py-1">
        <button
          data-menu-wont-do
          class="flex min-h-11 items-center px-3 py-2 text-left text-sm hover:bg-dusk/20"
          onclick={wontDo}
        >
          Won’t do
        </button>
        <button
          data-menu-pomodoro
          class="flex min-h-11 items-center px-3 py-2 text-left text-sm hover:bg-dusk/20"
          onclick={startPomodoro}
        >
          Start a pomodoro
        </button>
        <!-- A second step rather than a hover-out submenu: a submenu that opens
             sideways has nowhere to go at 320, and a finger has no hover to
             open it with. -->
        <button
          data-menu-send
          aria-expanded={choosingList}
          class="flex min-h-11 items-center justify-between px-3 py-2 text-left text-sm
                 hover:bg-dusk/20"
          onclick={() => (choosingList = true)}
        >
          Send to list
          <span aria-hidden="true" class="text-haze">›</span>
        </button>
      </div>
      <!-- Said rather than prevented, exactly as the modal says it: this half
           cannot see which pomodoro is running, and a claim it cannot check
           is one it must not make conditionally. -->
      <p class="meta border-t border-white/10 px-3 py-2 normal-case text-haze" data-menu-note>
        Starting one ends a pomodoro already running.
      </p>
    {/if}
  </div>
{/if}
