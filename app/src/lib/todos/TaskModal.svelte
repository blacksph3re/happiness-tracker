<script>
  import { onDestroy, tick as painted } from 'svelte'

  import ColourPicker from '../ColourPicker.svelte'
  import IconPicker from '../IconPicker.svelte'
  import { formatDuration, formatRunning, nowUtc } from '../clock.js'
  import { dayLabel } from '../day.js'
  import {
    archive,
    archiveList,
    archiveListId,
    removeStep,
    removeTodo,
    saveStep,
    saveTodo,
    todoLists,
    todos as todoStore,
  } from '../store.js'
  import { openLayer } from '../router.js'
  import { pushToast } from '../toasts.js'
  import { PRIORITIES, PRIORITY_LABELS } from '../todo-settings.js'
  import {
    abandon,
    activeSeconds,
    banked,
    stepCount,
    tick,
    untick,
    wallClock,
  } from './fields.js'
  import { listOrder } from './groupings.js'
  import { renderMarkdown } from './markdown.js'
  import { between, compareRank, isRank } from './rank.js'
  import { startFocus } from './start-focus.js'
  import { justTicked, markTicked } from './tick.js'
  import TickMark from './TickMark.svelte'

  /**
   * Everything about one task, opened from its title.
   *
   * Three rules shape the whole component:
   *
   * - **It reads the task from the store, never a snapshot.** `clientId` is the
   *   prop; the row is `$derived` from `todos`. A modal holding its own copy
   *   could not see a correction arriving from another device, and this is the
   *   one screen somebody leaves open.
   * - **There is no Save button.** A field saves itself when it changes, as one
   *   whole row through `saveTodo` — which is what `saveTodo` takes, and what
   *   makes a correction and a creation the same write. Text is debounced by
   *   `TYPING_DELAY`, the same shape preferences use, so a sentence is one
   *   intent rather than forty.
   * - **`Escape` commits, it does not discard.** One key means "never mind"
   *   everywhere in this app, and on a modal it means *close* — but the fields
   *   have been saving themselves all along, so discarding the last 600ms of
   *   typing would be the only place in the app where a keystroke was thrown
   *   away. So closing flushes what is pending first, by whichever route: the
   *   key, the backdrop, the button. The plan's *"closes without saving fields
   *   not yet blurred"* is deliberately not implemented; it would mean the
   *   debounce window silently decided whether a word survived.
   *
   *   Two paths write that last sentence, and measuring which one does the work
   *   is worth the paragraph: closing flushes, and leaving a field also commits
   *   it on `blur` — which fires when the dialog closes under a focused input.
   *   Either alone passes *"Escape closes the modal and keeps what was being
   *   typed"*; deleting both fails it. The redundancy is deliberate, because
   *   `blur` on a removed element is a browser behaviour rather than a
   *   guarantee. What is *not* allowed to be the thing that saves it is a
   *   pending timer, which is why they are cleared on teardown.
   */
  let {
    /** Which task, by the identity every device agrees on. */
    clientId,
    /** Called once the modal has closed and its writes are on disk. */
    onclose = () => {},
  } = $props()

  /**
   * The history entry that makes Back close the modal rather than leave the page.
   *
   * Pushed as the modal opens; every other way out gives it back through
   * `release`, or the next Back would land on the same page and do nothing.
   * Starting a pomodoro needs no release: its navigation takes the entry's
   * place, and the page going takes the modal with it.
   */
  const releaseHistory = openLayer(() => close())
  onDestroy(releaseHistory)

  /** How long typing stops before it becomes a write. As debounced as preferences. */
  const TYPING_DELAY = 600

  let dialog
  /** Which step's icon picker is open, by `client_id`. */
  let choosingIcon = $state(null)
  /** Whether the description is being read rather than written. */
  let previewing = $state(false)
  /** Whether Delete has asked its question. */
  let confirming = $state(false)

  /** Delete, and the confirmation's Cancel, for the focus to move between. */
  let deleteButton = $state(null)
  let keepButton = $state(null)

  /**
   * Ask before deleting, with the focus on the answer that keeps the task.
   *
   * The question replaces the button that raised it, so a press from the
   * keyboard left the focus on nothing — and Escape then closed the whole
   * modal rather than the question. Cancel rather than the confirming Delete,
   * so a second Enter is the safe one.
   */
  async function askDelete() {
    confirming = true
    await painted()
    keepButton?.focus()
  }

  /** Take the question back, and give the focus back to the Delete that asked it. */
  async function keepTask() {
    confirming = false
    await painted()
    deleteButton?.focus()
  }
  /** A new step's title, the only thing on this screen that is not a field. */
  let stepTitle = $state('')
  /** Now, in epoch milliseconds, republished while something is running. */
  let now = $state(Date.now())

  /**
   * What has been typed and not yet written, by key: `title`, `description`, or
   * `step:<client_id>`.
   *
   * The same guard `openBands` needed and for the same reason — a panel that
   * shows a value and then has a reply land on top of it wipes what somebody
   * typed in between. Here the reply is the store: a field reads what is typed
   * *if* anything is, and the store otherwise, so an arriving change is visible
   * everywhere except under the cursor.
   */
  let typed = $state({})

  /** Timers by the same key, so two fields debounce independently. */
  const timers = new Map()

  const lists = $derived($todoLists ?? [])

  /**
   * The task, live.
   *
   * The archive is looked in as well as the board, for the same reason the board
   * draws both: a task cleaned up on this device is in `todos` carrying the
   * archive's `list_id`, while one cleaned up last month is only in the page the
   * server sent.
   */
  const task = $derived(
    ($todoStore ?? []).find((row) => row.client_id === clientId) ??
      $archive.find((row) => row.client_id === clientId) ??
      null
  )

  const done = $derived(Boolean(task?.done_at))
  const steps = $derived((task?.steps ?? []).toSorted(compareRank))
  const counter = $derived(task ? stepCount(task) : null)
  const running = $derived(Boolean(task?.active_since))
  const worked = $derived(task ? activeSeconds(task, now) : 0)
  const description = $derived(typed.description ?? task?.description ?? '')

  /** The list the task is in, as this account sees it. */
  const home = $derived(lists.find((one) => one.id === task?.list_id) ?? null)

  /** Whether anybody besides this account can see the task — and its clock. */
  const shared = $derived(Boolean(home?.shared))

  /** The list options, in the one order this half draws its lists in. */
  const listOptions = $derived(listOrder(lists))

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal()
    // The browser focuses the first focusable child of a modal, which here is
    // the title field — so opening a task to read it would put a caret in its
    // name. The card itself takes the focus instead, which is also what makes
    // the first Tab land at the top of the form.
    dialog?.focus()
  })

  // Pending debounces do not outlive the component. Left to fire, a timer holds
  // a closure over a destroyed component's state and writes from it — which is
  // how the *"Escape keeps what was typed"* test came to pass with both the
  // flush on close and the blur commit deleted. It was an orphaned timer doing
  // the saving, which is not a guarantee anything should rest on.
  $effect(() => () => {
    for (const handle of timers.values()) clearTimeout(handle)
    timers.clear()
  })

  // A local interval rather than `lib/time/tick.js`: that module is in the time
  // zone, and this one may not reach across into it. One second, and only while
  // something is actually running — an effect reading `task.active_since`, which
  // is a string and therefore holds still, so the effect does not re-run on
  // every tick of its own clock.
  $effect(() => {
    if (!running) return
    now = Date.now()
    const handle = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(handle)
  })

  /**
   * Grow a textarea to hold its whole value, and shrink it back.
   *
   * Refitted on every keystroke, on a value arriving from elsewhere (the
   * action's parameter), and when the box changes *width* — which is when the
   * words rewrap, and also how the first fit happens: the modal is laid out
   * after this mounts. Width only, because the fit itself changes the height,
   * and an observer reacting to that would be answering its own write.
   *
   * @param {HTMLTextAreaElement} node
   */
  function grow(node) {
    let width = -1
    const fit = () => {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return
      width = entry.contentRect.width
      fit()
    })
    observer.observe(node)
    node.addEventListener('input', fit)
    fit()
    return {
      update: fit,
      destroy() {
        observer.disconnect()
        node.removeEventListener('input', fit)
      },
    }
  }

  /**
   * Write the whole task with one field changed.
   *
   * The whole row, not a patch: `todo.upsert` is a statement of what the task
   * *is*, which is what lets a correction survive the row having been deleted
   * elsewhere.
   *
   * @param {object} patch The fields that changed.
   */
  function write(patch) {
    if (!task) return
    saveTodo({ ...task, ...patch })
  }

  /**
   * Remember a keystroke and start the clock on writing it.
   *
   * @param {string} key `title`, `description` or `step:<client_id>`.
   * @param {string} value What is in the box now.
   */
  function type(key, value) {
    typed = { ...typed, [key]: value }
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => commit(key), TYPING_DELAY))
  }

  /**
   * Write one pending edit, if it is still pending.
   *
   * The entry is dropped only once the write has reached the store and only if
   * nothing has been typed since — dropping it first would show the old value
   * for a frame, and dropping it unconditionally would lose a keystroke that
   * landed during the await.
   *
   * @param {string} key Which pending edit.
   */
  async function commit(key) {
    clearTimeout(timers.get(key))
    timers.delete(key)
    const value = typed[key]
    if (value === undefined || !task) return
    if (key === 'title') {
      // A title is what identifies the task on every other screen, so an empty
      // one is refused rather than stored: the box reverts to what is saved.
      if (value.trim()) await saveTodo({ ...task, title: value.trim() })
    } else if (key === 'description') {
      await saveTodo({ ...task, description: value.trim() ? value : null })
    } else if (key === 'duration_minutes') {
      const minutes = Number(value)
      await saveTodo({
        ...task,
        duration_minutes: minutes > 0 ? Math.round(minutes) : null,
      })
    } else {
      const step = steps.find((one) => `step:${one.client_id}` === key)
      if (step && value.trim()) await saveStep(task.client_id, { ...step, title: value.trim() })
    }
    if (typed[key] !== value) return
    const next = { ...typed }
    delete next[key]
    typed = next
  }

  /**
   * Close, once everything typed has been written.
   *
   * Every route out comes through here — the key, the backdrop and the button —
   * because a flush that only one of them did would make which key you pressed
   * decide whether a sentence survived.
   */
  async function close() {
    await Promise.all(Object.keys(typed).map(commit))
    releaseHistory()
    dialog?.close()
    onclose()
  }

  /**
   * Start a pomodoro on this task, which takes the reader to the timer.
   *
   * What was typed is committed first, as closing does: the press navigates
   * away and takes the modal down with the page, and a title still inside its
   * debounce would otherwise be the one thing that never saved — and the
   * pomodoro would be named by the title before it.
   */
  async function beginFocus() {
    await Promise.all(Object.keys(typed).map(commit))
    if (task) await startFocus(task)
  }

  /**
   * A neighbour's key if the encoding can read it, or no bound at all.
   *
   * A step ranked by an older write outside the alphabet (`m9`) would make
   * `between` throw on the press; passed over, the step still moves and the
   * key it writes is well-formed.
   *
   * @param {string|null} key
   * @returns {string|null}
   */
  function readable(key) {
    return isRank(key) ? key : null
  }

  /** Move a step one place up or down, which is a rank between its new neighbours. */
  function reorder(step, delta) {
    const at = steps.findIndex((one) => one.client_id === step.client_id)
    const to = at + delta
    if (to < 0 || to >= steps.length) return
    const before = delta < 0 ? (steps[to - 1]?.rank ?? null) : steps[to].rank
    const after = delta < 0 ? steps[to].rank : (steps[to + 1]?.rank ?? null)
    saveStep(task.client_id, { ...step, rank: between(readable(before), readable(after)) })
  }

  function addStep() {
    const title = stepTitle.trim()
    if (!title || !task) return
    stepTitle = ''
    saveStep(task.client_id, {
      title,
      rank: between(readable(steps.at(-1)?.rank ?? null), null),
    })
  }

  /**
   * Move the task to a list, which for the archive is *won't do*.
   *
   * Said on the screen and meant in the code: the same helper the verb uses, so
   * choosing the archive here cannot bank an active task differently from the
   * button that does the same thing six lines down.
   *
   * @param {number} into The list chosen.
   */
  function moveTo(into) {
    if (!task) return
    if (into === archiveListId()) {
      wontDo()
      return
    }
    write({ list_id: into })
  }

  /**
   * Give up on the task, which is a move to the archive and nothing else.
   *
   * The toast names where it went, and it is the one confirmation in this
   * modal: starting a pomodoro takes you to the timer, which says it, while a
   * *won't do* takes the task out of the list you are looking at — so the press
   * is followed by the card disappearing and nothing at all saying why. Named
   * from the list row rather than from the word "archive", which is renameable.
   */
  async function wontDo() {
    const into = archiveListId()
    if (!into || !task) return
    // Read before the write: a task leaving a list somebody else owns is filed
    // in *their* archive by the server, and is gone from this device the moment
    // it is saved — so the toast names that archive rather than this account's.
    const owner = home?.members === null ? home.owner : null
    await saveTodo(abandon(task, into, now))
    pushToast(
      owner ? `Moved to ${owner}’s archive` : `Moved to ${$archiveList?.name ?? 'the archive'}`,
      'ok'
    )
    await close()
  }

  async function remove() {
    const id = task?.client_id
    if (!id) return
    // Nothing pending is written: the row is going. Committing first would
    // queue an upsert behind a delete, which the server would apply in order
    // and bring the task back.
    typed = {}
    for (const handle of timers.values()) clearTimeout(handle)
    timers.clear()
    await removeTodo(id)
    releaseHistory()
    dialog?.close()
    onclose()
  }
</script>

<!-- A native `<dialog>`, opened with `showModal`: the focus trap, `aria-modal`,
     the top layer and the backdrop are the browser's, and a hand-rolled overlay
     would be forty lines re-implementing them slightly worse. A click whose
     target is the dialog itself landed on the backdrop — the box's own content
     is a child — which is what makes clicking outside close it. -->
<dialog
  bind:this={dialog}
  data-task-modal
  tabindex="-1"
  aria-label={task ? `Task: ${task.title}` : 'Task'}
  class="m-auto max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto
         rounded-xl border border-white/10 bg-ink p-0 text-paper
         backdrop:bg-black/70"
  onclick={(event) => {
    if (event.target === dialog) close()
  }}
  oncancel={(event) => {
    // The default would close the dialog before anything pending is written.
    event.preventDefault()
    // Escape while Delete is asking takes back the question, not the modal.
    if (confirming) {
      keepTask()
      return
    }
    close()
  }}
>
  {#if task}
    <div class="flex flex-col gap-5 p-5">
      <!-- The title takes the modal's whole width, and Close sits on the kind's
           line above it. Beside the title, Close took 90px of a 254px row at
           320 and a 138-character title ran to ten lines in a 178px column. -->
      <header class="flex flex-col gap-1">
        <div class="flex items-center justify-between gap-3">
          <!-- The word and nothing else. It used to carry the step counter,
               which read as `TASK 3/10` — *task 3 of 10*, which is not a thing
               this app has — while the same number sat under a heading reading
               `STEPS 3/10` twelve lines down. Two places for one number is how
               two numbers on one screen come to disagree, and this was the one
               lying about what it counted. -->
          <p class="meta" data-task-kind>{done ? 'Done' : 'Task'}</p>
          <button
            data-close
            aria-label="Close"
            class="btn-outline meta shrink-0"
            onclick={close}
          >
            Close
          </button>
        </div>
          <!-- A textarea so a long title wraps rather than scrolling sideways
               inside one line; it is still one line of *text*. Enter adds
               nothing, as it did in the input, and a pasted line break
               becomes a space — replaced one character for one, so the caret
               stays where it was. -->
          <textarea
            data-field="title"
            aria-label="Task title"
            rows="1"
            value={typed.title ?? task.title}
            use:grow={typed.title ?? task.title}
            onkeydown={(event) => {
              if (event.key === 'Enter' && !event.isComposing) event.preventDefault()
            }}
            oninput={(event) => {
              const node = event.currentTarget
              if (node.value.includes('\n')) {
                const caret = node.selectionStart
                node.value = node.value.replaceAll('\n', ' ')
                node.setSelectionRange(caret, caret)
              }
              type('title', node.value)
            }}
            onblur={() => commit('title')}
            class="block w-full resize-none overflow-hidden rounded-lg border border-white/15
                   bg-ink-soft px-3 py-2 text-lg font-semibold tracking-tight"
          ></textarea>
      </header>

      <!-- Markdown, written in a textarea and read through `marked` and
           `DOMPurify`. The toggle is a toggle rather than a live split view:
           one column on a phone is the width there is. -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="meta">Notes</span>
          <button
            data-preview-toggle
            aria-pressed={previewing}
            class="meta rounded-md border px-3 py-1.5 transition
                   {previewing ? 'border-ember bg-ember/10 text-paper' : 'border-white/15 hover:border-white/40'}"
            onclick={() => (previewing = !previewing)}
          >
            {previewing ? 'Edit' : 'Preview'}
          </button>
        </div>
        {#if previewing}
          <div
            data-preview
            class="prose-todo min-h-24 rounded-lg border border-white/10 bg-ink-soft px-3 py-2 text-sm"
          >
            {#if description.trim()}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html renderMarkdown(description)}
            {:else}
              <span class="meta text-haze">No notes.</span>
            {/if}
          </div>
        {:else}
          <textarea
            data-field="description"
            aria-label="Notes"
            rows="4"
            value={description}
            oninput={(event) => type('description', event.currentTarget.value)}
            onblur={() => commit('description')}
            class="w-full rounded-lg border border-white/15 bg-ink-soft px-3 py-2 text-sm"
          ></textarea>
        {/if}
      </div>

      <!-- A native date or time input renders in the *browser's* UI language,
           which nobody in this app chose and the reader cannot change from
           here: `09/12/2026` and `05:00 PM` beside cards reading `SAT, SEP 12`
           and `17:00`. The control stays — a native picker is the right one on
           a phone, and there is no replacement that is not worse there — so
           each field states its own value underneath it in the app's spelling,
           which is `dayLabel`, the function the cards use. Two readings of one
           value, from one function, so they cannot appear to disagree. -->
      <!-- `grid-cols-1` is `minmax(0, 1fr)`, and `min-w-0` on every field: a grid
           item and a flex item both default to their content's minimum, and a
           native date input at the coarse pointer's 16px has one wider than a
           320px modal — five fields ended 32px past its edge. -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1.5">
          <span class="meta">Planned</span>
          <input
            type="date"
            data-field="planned_on"
            required
            value={task.planned_on}
            onchange={(event) => {
              // Mandatory, for now: every view of this half is organised by the
              // planned date, so a task without one would be a task with no
              // column. An emptied box reverts rather than saving nothing.
              const value = event.currentTarget.value
              if (!value) {
                event.currentTarget.value = task.planned_on
                return
              }
              write({ planned_on: value })
            }}
            class="w-full min-w-0 rounded-lg border border-white/15 bg-ink-soft px-3 py-2 text-sm"
          />
          <span class="meta" data-reads="planned_on">{dayLabel(task.planned_on)}</span>
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="meta">At</span>
          <span class="flex items-stretch gap-2">
            <input
              type="time"
              data-field="planned_at"
              value={wallClock(task.planned_at) ?? ''}
              onchange={(event) => write({ planned_at: event.currentTarget.value || null })}
              class="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink-soft px-3 py-2 text-sm"
            />
            {#if task.planned_at}
              <button
                data-clear="planned_at"
                aria-label="Clear the time"
                class="meta rounded-md border border-white/15 px-3 hover:border-ember"
                onclick={() => write({ planned_at: null })}
              >
                ×
              </button>
            {/if}
          </span>
          {#if task.planned_at}
            <span class="meta" data-reads="planned_at">{wallClock(task.planned_at)}</span>
          {/if}
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="meta">Due</span>
          <span class="flex items-stretch gap-2">
            <input
              type="date"
              data-field="due_on"
              value={task.due_on ?? ''}
              onchange={(event) => write({ due_on: event.currentTarget.value || null })}
              class="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink-soft px-3 py-2 text-sm"
            />
            {#if task.due_on}
              <button
                data-clear="due_on"
                aria-label="Clear the due date"
                class="meta rounded-md border border-white/15 px-3 hover:border-ember"
                onclick={() => write({ due_on: null })}
              >
                ×
              </button>
            {/if}
          </span>
          {#if task.due_on}
            <span class="meta" data-reads="due_on">{dayLabel(task.due_on)}</span>
          {/if}
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="meta">Priority</span>
          <select
            data-field="priority"
            value={task.priority ?? ''}
            onchange={(event) => write({ priority: event.currentTarget.value || null })}
            class="w-full min-w-0 rounded-lg border border-white/15 bg-ink-soft px-3 py-2 text-sm"
          >
            <option value="">None</option>
            {#each PRIORITIES as priority (priority)}
              <option value={priority}>{PRIORITY_LABELS[priority]}</option>
            {/each}
          </select>
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="meta">Estimate</span>
          <span class="flex items-stretch gap-2">
            <!-- Typed, so it is debounced like the title and the notes rather
                 than saved on `change`. A `change` event on a text-like field
                 does not fire until the focus leaves it, so an estimate typed
                 as the last thing before closing was silently not saved — the
                 debounce is also what makes the flush on close cover it.
                 Pickers are different and stay on `change`: a date input
                 commits a whole value at once. -->
            <input
              type="number"
              min="0"
              step="5"
              data-field="duration_minutes"
              aria-label="Estimate in minutes"
              value={typed.duration_minutes ?? task.duration_minutes ?? ''}
              oninput={(event) => type('duration_minutes', event.currentTarget.value)}
              onblur={() => commit('duration_minutes')}
              class="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink-soft px-3 py-2 text-sm"
            />
            <span class="meta self-center">minutes</span>
          </span>
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="meta">List</span>
          <select
            data-field="list_id"
            value={task.list_id}
            onchange={(event) => moveTo(Number(event.currentTarget.value))}
            class="w-full min-w-0 rounded-lg border border-white/15 bg-ink-soft px-3 py-2 text-sm"
          >
            {#each listOptions as one (one.id)}
              <option value={one.id}>{one.name}</option>
            {/each}
          </select>
        </label>
      </div>

      <!-- Collapsed here and nowhere else. Fifty icons always on screen was
           the largest thing in this modal and the control least often used in
           it, so a task opened to move a date was mostly a grid of emoji. The
           catalogue's question form keeps the grid open: that page is about one
           question, where nothing is competing with it. -->
      <div class="flex flex-col gap-4 rounded-lg border border-white/10 p-4">
        <IconPicker
          value={task.icon}
          label="Icon"
          collapsed
          onchange={(icon) => write({ icon: icon ?? null })}
        />
        <!-- Beside the icon, and picked rather than typed for the same reason:
             the six tokens are what there is, and *List colour* is the seventh
             choice rather than a cleared field — null on `colour` means take
             the list's, which is what every card drew before a task could
             carry one. A picked field saves on `change`, so this write goes at
             once and never through the typing debounce. -->
        <ColourPicker
          value={task.colour ?? null}
          label="Colour"
          inherit="List colour"
          onchange={(colour) => write({ colour })}
        />
      </div>

      <!-- The running total beside the toggle, which is the point of the
           toggle: time on a task is two columns, `active_seconds` banked and
           `active_since` for the run in progress, and the sum is the only
           number worth reading. -->
      <div class="flex items-center justify-between gap-3 rounded-lg border border-white/10 p-4">
        <span class="flex flex-col gap-0.5">
          <span class="meta">Worked</span>
          <!-- One spelling, from `lib/clock.js`. Seconds only while it runs:
               a stopped total is read rather than watched, and everywhere else
               in this app a duration read is hours and whole minutes. -->
          <span class="flex flex-wrap items-baseline gap-x-2">
            <span class="numeral text-lg" data-active-total>
              {running ? formatRunning(worked) : formatDuration(worked)}
            </span>
            <!-- The clock is a column on the task, so on a shared list it is
                 one clock for everybody on it — the number is not this
                 person's time, and it is labelled rather than quietly meaning
                 something different from the same number on a private task.
                 Prose beside a numeral, so not a `.meta`. -->
            {#if shared}
              <span class="text-sm text-haze" data-active-scope>across everyone</span>
            {/if}
          </span>
        </span>
        <button
          data-active-toggle
          aria-pressed={running}
          class="rounded-lg px-4 py-2 text-sm font-semibold transition
                 {running ? 'bg-dusk hover:bg-dusk-lift' : 'border border-white/15 hover:border-white/40'}"
          onclick={() => write(running ? banked(task, now) : { active_since: nowUtc() })}
        >
          {running ? 'Stop' : 'Start working'}
        </button>
      </div>

      <div class="flex flex-col gap-2" data-steps>
        <span class="meta">
          Steps
          {#if counter}<span class="numeral" data-step-count>{counter}</span>{/if}
        </span>
        {#each steps as step (step.client_id)}
          {@const stepKey = `step:${step.client_id}`}
          <!-- Every control in this row is a 44px target drawn as a 32px box,
               by the negative-margin trick the task card's tickbox uses: the
               button occupies its old 32px of layout and reaches 6px past it
               on every side, into the gaps and the row's own padding. Ten
               steps on a phone is forty of these, and they were 26×31.

               The reach is larger than the 4px gaps, so two neighbours' hit
               areas overlap across the gap between them — which is the trade
               the trick makes and is the right one: five 44px targets beside a
               readable title cannot fit on a 320px row, and a tap on any drawn
               box still lands on its own control. The forgiveness is in the
               space between them. -->
          <div class="flex flex-col gap-2 rounded-lg border border-white/10 px-1.5 py-2" data-step>
            <div class="flex items-center gap-1" data-step-row>
              <button
                data-step-tick
                aria-pressed={Boolean(step.done_at)}
                aria-label={step.done_at
                  ? `Untick “${step.title}”`
                  : `Tick “${step.title}”`}
                class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
                onclick={() => {
                  // The same stamp the board's tick takes, so a step drawn
                  // ticked here draws itself in and one that arrived ticked
                  // does not. See `tick.js`.
                  if (!step.done_at) markTicked(step.client_id)
                  saveStep(task.client_id, {
                    ...step,
                    done_at: step.done_at ? null : nowUtc(),
                  })
                }}
              >
                <TickMark
                  done={Boolean(step.done_at)}
                  icon={step.icon}
                  drawing={Boolean(step.done_at) && justTicked(step.client_id)}
                />
              </button>
              <input
                data-step-title
                aria-label={`Title of “${step.title}”`}
                value={typed[stepKey] ?? step.title}
                oninput={(event) => type(stepKey, event.currentTarget.value)}
                onblur={() => commit(stepKey)}
                class="min-w-0 flex-1 rounded-md border border-white/10 bg-ink-soft px-2 py-1.5
                       text-sm {step.done_at ? 'text-haze line-through' : ''}"
              />
              <!-- A bare `·` was the whole of this control, which is a
                   punctuation mark where a button belongs. The chosen icon is
                   already drawn in the tickbox, as it is on a card, so this one
                   draws the *offer* rather than a second copy of the answer:
                   a dashed box, meaning there is something to put in it. -->
              <button
                data-step-icon
                aria-expanded={choosingIcon === step.client_id}
                aria-label={`Icon for “${step.title}”`}
                class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
                onclick={() =>
                  (choosingIcon = choosingIcon === step.client_id ? null : step.client_id)}
              >
                <span
                  class="flex size-8 items-center justify-center rounded-md border border-dashed
                         text-base leading-none transition
                         {choosingIcon === step.client_id
                    ? 'border-ember bg-ember/10 text-paper'
                    : 'border-white/25 text-haze group-hover:border-white/40'}"
                >
                  {#if step.icon}
                    <span aria-hidden="true">{step.icon}</span>
                  {:else}
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.4" />
                      <circle cx="5.9" cy="6.4" r="0.85" fill="currentColor" />
                      <circle cx="10.1" cy="6.4" r="0.85" fill="currentColor" />
                      <path
                        d="M5.5 9.9c.6.8 1.4 1.2 2.5 1.2s1.9-.4 2.5-1.2"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                      />
                    </svg>
                  {/if}
                </span>
              </button>
              <button
                data-step-up
                aria-label={`Move “${step.title}” up`}
                class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
                onclick={() => reorder(step, -1)}
              >
                <span
                  class="meta flex size-8 items-center justify-center rounded-md border
                         border-white/15 leading-none group-hover:border-white/40"
                >
                  ↑
                </span>
              </button>
              <button
                data-step-down
                aria-label={`Move “${step.title}” down`}
                class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
                onclick={() => reorder(step, 1)}
              >
                <span
                  class="meta flex size-8 items-center justify-center rounded-md border
                         border-white/15 leading-none group-hover:border-white/40"
                >
                  ↓
                </span>
              </button>
              <button
                data-step-delete
                aria-label={`Delete “${step.title}”`}
                class="group -m-1.5 flex size-11 shrink-0 items-center justify-center"
                onclick={() => removeStep(step.client_id)}
              >
                <span
                  class="meta flex size-8 items-center justify-center rounded-md border
                         border-white/15 leading-none group-hover:border-ember"
                >
                  ×
                </span>
              </button>
            </div>
            {#if choosingIcon === step.client_id}
              <div class="border-t border-white/10 pt-2">
                <IconPicker
                  value={step.icon}
                  label={`Icon for “${step.title}”`}
                  collapsed
                  onchange={(icon) => {
                    saveStep(task.client_id, { ...step, icon: icon ?? null })
                    choosingIcon = null
                  }}
                />
              </div>
            {/if}
          </div>
        {/each}
        <input
          data-step-add
          aria-label="Add a step"
          placeholder="Add a step…"
          autocomplete="off"
          bind:value={stepTitle}
          onkeydown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            addStep()
          }}
          class="rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm
                 placeholder:text-haze/60 hover:border-white/30 focus:border-dusk-lift
                 focus:outline-none"
        />
      </div>

      <footer class="flex flex-col gap-2 border-t border-white/10 pt-4">
        <div class="flex flex-wrap items-center gap-2">
        <button
          data-tick-task
          class="btn-filled"
          onclick={() => write(done ? untick(task) : tick(task, now))}
        >
          {done ? 'Untick' : 'Tick'}
        </button>
        <button
          data-wont-do
          class="btn-outline meta"
          onclick={wontDo}
        >
          Won’t do
        </button>
        <button
          data-start-pomodoro
          class="btn-outline meta"
          onclick={beginFocus}
        >
          Start a pomodoro
        </button>
        <span class="flex-1"></span>
        {#if confirming}
          <!-- The question in place of the button that raised it, as the
               pomodoro list does it: the answer should not sit next to the
               thing that asked. -->
          <span class="meta hidden normal-case sm:inline">Delete it?</span>
          <button
            data-delete-confirm
            class="btn-danger meta border-alarm text-paper"
            onclick={remove}
          >
            Delete
          </button>
          <button
            bind:this={keepButton}
            data-delete-cancel
            class="btn-outline meta"
            onclick={keepTask}
          >
            Cancel
          </button>
        {:else}
          <button
            bind:this={deleteButton}
            data-delete
            class="btn-danger meta"
            onclick={askDelete}
          >
            Delete
          </button>
        {/if}
        </div>
        <!-- Said rather than hidden, and said always. The offer stood
             unchanged while a pomodoro was running, beside a panel that had
             already flipped to *Stop* — and the press does end the running
             block, which is the app's one rule about it and the only way out
             of a break there is.

             Unconditional because this half cannot see the focus phase: which
             pomodoro is running is `lib/pomodoro/derive.js`'s rule, and
             reaching for it from here points across a zone, while re-deriving
             it locally would be a second spelling of it. What the modal can
             say is what the press *does*, which is true either way — the same
             shape as the note under the list select. -->
        <span class="meta normal-case text-haze" data-pomodoro-note>
          Starting one ends a pomodoro already running.
        </span>
      </footer>
    </div>
  {:else}
    <!-- The row has gone: deleted here, or archived on another device while
         this was open. Nothing is invented in its place. -->
    <div class="flex flex-col items-start gap-3 p-5">
      <p class="text-sm text-haze">This task is no longer on this device.</p>
      <button
        data-close
        class="btn-outline meta"
        onclick={close}
      >
        Close
      </button>
    </div>
  {/if}
</dialog>
