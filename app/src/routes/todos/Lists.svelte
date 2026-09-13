<script>
  import AdminOffline, { OFFLINE_HINT } from '../../lib/AdminOffline.svelte'
  import IconBin from '../../lib/IconBin.svelte'
  import IconPlus from '../../lib/IconPlus.svelte'
  import { attempt, unwrap } from '../../lib/api.js'
  import {
    createTodoList,
    deleteTodoList,
    updateTodoList,
  } from '../../lib/generated/sdk.gen'
  import { CHIP_COLOURS, chipColour, nextColour } from '../../lib/palette.js'
  import { resource } from '../../lib/resource.svelte.js'
  import {
    archiveList,
    ensureTodoLists,
    ensureTodos,
    forgetTodo,
    inboxList,
    leaveTodoList,
    shareTodoList,
    todoLists,
    todos as todoStore,
    unshareTodoList,
  } from '../../lib/store.js'
  import { connection } from '../../lib/sync.js'
  import { listOrder } from '../../lib/todos/groupings.js'
  import { between } from '../../lib/todos/rank.js'
  import { pushToast } from '../../lib/toasts.js'

  /**
   * Making, renaming, recolouring, reordering, sharing and deleting lists.
   *
   * **Online-only CRUD**, like projects and tags and for the same reason: a
   * container is not something you make on a train. The consequence worth
   * naming is the one the plan names — a task created offline needs its list's
   * id from the snapshot, so a device that has never once synced cannot create
   * one, exactly as it cannot check in to a project it has never heard of.
   * Sharing is membership of a container, so it is online-only too.
   *
   * Two things here are keyed on `kind` and never on the name, because both
   * system lists are renameable and anything reading "Archive" is a bug waiting
   * for somebody to rename it: which lists can be deleted or shared, and the
   * order they are drawn in.
   *
   * **A list somebody else owns is read, never edited, from here.** The server
   * says whose roster is whose by sending `members: null` to anybody who is not
   * the owner, and every control it would refuse — rename, colour, order,
   * share, delete — is *hidden* on such a row rather than disabled: nothing a
   * member can do makes them available, and a greyed control promises a way.
   */

  let newList = $state('')

  /** A colour chosen for the new list, or null to take the rotation. */
  let newColour = $state(null)

  /** Which list's delete has asked its question, by id. */
  let confirming = $state(null)

  /** Which shared list's Leave has asked its question, by id. */
  let leaving = $state(null)

  /** Which list's share panel is open, by id. */
  let sharing = $state(null)

  /** The username typed into the open share panel. */
  let invitee = $state('')

  /**
   * Why the last Add did not share, in words, beside the box.
   *
   * Not a toast: the person is looking at the box they typed into, and a
   * sentence that vanishes after five seconds is one they may not have read.
   */
  let inviteError = $state(null)

  const loaded = resource(
    () => null,
    () => Promise.all([ensureTodoLists(), ensureTodos()]),
    { name: 'todo lists' }
  )

  const lists = $derived($todoLists ?? [])
  const tasks = $derived($todoStore ?? [])

  // True only while there is nothing to draw, never while a request is out: the
  // snapshot restores both stores before either read is sent.
  const loading = $derived(loaded.loading && lists.length === 0)

  /** Nothing here queues, so nothing here is offered without a connection. */
  const offline = $derived($connection !== 'online')

  /** Set on every control the connection is holding down, and on no other. */
  const hint = $derived(offline ? OFFLINE_HINT : undefined)

  // A confirmation left standing when the signal goes is a question whose
  // answer cannot be carried out. Reads `offline` and writes only what it
  // closes, so there is nothing here to feed itself.
  $effect(() => {
    if (offline) {
      confirming = null
      leaving = null
    }
  })

  const inbox = $derived($inboxList)
  const archived = $derived($archiveList)

  /** The lists somebody can reorder, which is every ordinary one, in rank order. */
  const ordinary = $derived(
    lists.filter((one) => one.kind === 'ordinary').toSorted((a, b) => (a.rank < b.rank ? -1 : 1))
  )

  /** Every list as it is drawn: inbox, the ordinary ones, archive. */
  const rows = $derived(listOrder(lists))

  /**
   * The colour `+` will actually use.
   *
   * The rotation was already the default inside `add()`, which meant the form
   * showed no selected swatch and a new list came out iris with nothing having
   * said so. One derived value drawn by the ring *and* sent by the write, so
   * the picture and the outcome cannot disagree — and after an add the ring
   * moves along, because the rotation has.
   */
  const chosenColour = $derived(newColour ?? nextColour(ordinary.length))

  /**
   * Whether a list belongs to somebody else.
   *
   * `members` is `null` exactly when the roster is not this account's to see,
   * which is exactly when it is not this account's list.
   *
   * @param {import('../../lib/generated/types.gen').TodoListOut} list
   */
  function theirs(list) {
    return list.members === null
  }

  /**
   * How many tasks a list holds, open and in total.
   *
   * Counted off `todos`, which is everything outside the archive — so the
   * archive's own numbers are the rows this device archived and has not yet
   * synced, and nothing more. That is the honest answer from here: the archive
   * is paged and not in the snapshot, and a count this page invented for it
   * would be a number that disagreed with the board's.
   *
   * Which is why **the archive's row prints no count at all**. It printed a
   * permanent `0 open` beside a board column drawing fourteen cards, and a
   * docstring explaining why a number is wrong does not make it right: nothing
   * is the honest reading, and the badge already says what the row is.
   *
   * Both numbers are drawn for every other row, because the board's Lists
   * grouping heads its column with the *total* — a bare `54` where this page
   * said `48 open`. Said as one reading, `48 open of 54`, the two cannot read
   * as disagreeing. The total is left off when it is the same number, which is
   * the ordinary case.
   *
   * @param {number} id A list's id.
   * @returns {{open: number, all: number}}
   */
  function counts(id) {
    const mine = tasks.filter((one) => one.list_id === id)
    return { open: mine.filter((one) => !one.done_at).length, all: mine.length }
  }

  async function refresh() {
    await Promise.all([ensureTodoLists({ force: true }), ensureTodos({ force: true })])
  }

  /**
   * Save one field of a list.
   *
   * @param {object} list
   * @param {object} body A `TodoListUpdate`. Omitted fields are left alone.
   */
  async function save(list, body) {
    const saved = await attempt(() => updateTodoList({ path: { list_id: list.id }, body }))
    if (!saved) return
    await refresh()
  }

  async function add() {
    const name = newList.trim()
    if (!name) return
    // No rank sent: the server appends between the inbox and the archive, which
    // is the one place that arithmetic lives.
    const created = await attempt(() =>
      createTodoList({ body: { name, colour: chosenColour } })
    )
    if (!created) return
    newList = ''
    newColour = null
    await refresh()
  }

  /**
   * Delete a list and everything in it.
   *
   * Two halves, and the local one is not tidiness: the server cascades, so a
   * board still holding those tasks would draw cards whose list no longer
   * exists until something re-read. `forgetTodo` takes them out of the store
   * and records each one as gone in the write-during-read map, so a read still
   * in the air cannot hand them back, and then the re-read confirms it — which
   * is what makes the board correct without a reload.
   *
   * An archived task is **not** taken: it is in the archive list, not in the
   * one being deleted, which is what the plan settled and what the rows bought
   * over a flag.
   *
   * @param {object} list
   */
  async function remove(list) {
    const going = tasks.filter((one) => one.list_id === list.id)
    try {
      await unwrap(() => deleteTodoList({ path: { list_id: list.id } }))
    } catch (error) {
      pushToast(error.message)
      return
    }
    confirming = null
    for (const one of going) forgetTodo(one.client_id)
    await refresh()
    pushToast(`Removed ${list.name}`, 'ok')
  }

  /**
   * Move an ordinary list one place along.
   *
   * Bounded by the two system lists rather than by null, and that is the whole
   * care this function needs. The inbox's rank is `"a"`, which is the zero of
   * the rank encoding — `between(null, 'a')` has nothing to return and raises —
   * so the lower bound is always a real key. The archive's `"z"` closes the
   * other end for the same reason a new list is appended between them.
   *
   * A list shared with this account is one of the neighbours, because it is
   * drawn among the ordinary ones by its owner's rank: stepping past it has to
   * land on the far side of the row somebody can see.
   *
   * @param {object} list
   * @param {number} delta `-1` to move it earlier, `1` later.
   */
  async function move(list, delta) {
    const from = ordinary.findIndex((one) => one.id === list.id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ordinary.length) return
    const rest = ordinary.filter((one) => one.id !== list.id)
    const before = to === 0 ? (inbox?.rank ?? null) : rest[to - 1].rank
    const after = to < rest.length ? rest[to].rank : (archived?.rank ?? null)
    await save(list, { rank: between(before, after) })
  }

  /** Open or close one list's share panel, starting it empty. */
  function toggleSharing(list) {
    sharing = sharing === list.id ? null : list.id
    invitee = ''
    inviteError = null
  }

  /**
   * Share the open panel's list with the typed username.
   *
   * A 404 is the one refusal worth its own sentence — a mistyped name is the
   * ordinary way this goes wrong — and the server's own words stand for the
   * rest, which are already sentences.
   *
   * @param {object} list
   */
  async function invite(list) {
    const name = invitee.trim()
    if (!name) return
    inviteError = null
    try {
      await shareTodoList(list, name)
    } catch (error) {
      inviteError = error.status === 404 ? `No account called ${name}` : error.message
      return
    }
    invitee = ''
  }

  /**
   * Take one person off a list this account owns.
   *
   * @param {object} list
   * @param {string} name
   */
  async function stopSharing(list, name) {
    try {
      await unshareTodoList(list, name)
    } catch (error) {
      pushToast(error.message)
    }
  }

  /**
   * Leave a list somebody else shared with this account.
   *
   * @param {object} list
   */
  async function leave(list) {
    try {
      await leaveTodoList(list)
    } catch (error) {
      pushToast(error.message)
      return
    }
    leaving = null
    pushToast(`Left ${list.name}`, 'ok')
  }
</script>

<!-- `px-3` below `sm`, not `px-5`: at 320 the six colour swatches need 264px of
     the 320 for six 44px targets that do not overlap, and a 40px gutter plus a
     40px card inset left 238. 12px is the gutter every other row here can
     afford at that width. -->
<section class="mx-auto w-full max-w-4xl px-3 py-8 sm:px-5">
  <p class="meta">Where tasks live</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">Lists</h1>

  <AdminOffline does="Lists are shared between your devices" />

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each rows as list (list.id)}
        {@const held = counts(list.id)}
        {@const system = list.kind !== 'ordinary'}
        {@const foreign = theirs(list)}
        {@const spot = ordinary.findIndex((one) => one.id === list.id)}
        <li
          data-list-row={list.id}
          data-kind={list.kind}
          class="rounded-lg border border-white/10 bg-ink-soft px-3 py-3 sm:px-5 sm:py-4"
        >
          <!-- One `flex-wrap` does not make a row of groups. This held the name
               beside a control group that was `shrink-0 flex-wrap`: it claimed
               289px and never yielded, so the name field measured **26px** at
               320 on the system rows and 26px at 390 and 430 on the ordinary
               ones — four characters of a list's name, at every phone width,
               and the delete button 10px off the right edge at 320.
               The name is the group that keeps the line: `basis-64` is its
               floor, and the controls take `basis-full` below `sm` so they wrap
               to their own line *under* a readable name rather than squeezing
               it. -->
          <div class="flex flex-wrap items-center gap-3">
            <div class="flex min-w-0 flex-1 basis-64 items-center gap-3">
              <span
                class="size-3 shrink-0 rounded-full"
                data-list-dot={list.id}
                style:background={chipColour(list.colour)}
                aria-hidden="true"
              ></span>
              <div class="min-w-0 flex-1">
                {#if foreign}
                  <!-- Text, not a field: the owner renames it. The same box as
                       the field beside it on other rows, border included, so
                       the names line up down the page. -->
                  <span
                    data-list-name={list.id}
                    class="flex min-h-11 w-full items-center rounded-md border border-transparent
                           px-3 py-2 text-sm font-medium break-words"
                  >
                    {list.name}
                  </span>
                {:else}
                  <!-- Renamed in place, saved on `change`: a name is a whole
                       value committed at once rather than something typed into
                       the app's state, which is why this is not debounced. -->
                  <input
                    data-list-name={list.id}
                    aria-label={`Name of ${list.name}`}
                    value={list.name}
                    maxlength="60"
                    disabled={offline}
                    title={hint}
                    class="min-h-11 w-full rounded-md border border-white/10 bg-ink px-3 py-2
                           text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
                    onchange={(event) => {
                      const wanted = event.currentTarget.value.trim()
                      // Refused rather than stored: a nameless list is a column
                      // with no heading, and every view of this half draws one.
                      if (!wanted) {
                        event.currentTarget.value = list.name
                        return
                      }
                      save(list, { name: wanted })
                    }}
                  />
                {/if}
                <p class="meta mt-1">
                  {#if list.kind === 'archive'}
                    <!-- No count: this page cannot know it, and the badge
                         already says what the row is. -->
                    <span data-list-badge={list.id}>Archive</span>
                  {:else}
                    <span data-list-count={list.id}
                      >{held.open} open{held.all > held.open ? ` of ${held.all}` : ''}</span
                    >
                    {#if list.kind === 'inbox'}
                      <!-- The badge says *what* it is, which is what makes the
                           absent delete legible rather than a missing button. -->
                      · <span data-list-badge={list.id}>Inbox</span>
                    {/if}
                  {/if}
                </p>
                <!-- Its own line and not a `.meta`: a username is somebody's
                     spelling of themselves, and capitals would change it. -->
                {#if foreign}
                  <p class="mt-1 text-sm break-words text-haze" data-list-sharing={list.id}>
                    Shared by {list.owner}
                  </p>
                {:else if list.shared}
                  <p class="mt-1 text-sm break-words text-haze" data-list-sharing={list.id}>
                    Shared with {list.members.join(', ')}
                  </p>
                {/if}
              </div>
            </div>

            {#if foreign}
              <!-- A member's only control. Leave asks first, because it takes
                   every task in the list off this board and nothing here can
                   bring them back — only the owner can share it again. -->
              <div class="flex basis-full flex-wrap items-center justify-end gap-2 sm:basis-auto">
                {#if leaving === list.id}
                  <span
                    class="flex-1 basis-full text-sm text-haze sm:basis-auto"
                    data-list-leave-ask={list.id}
                  >
                    {`Leave ${list.name}? Its tasks leave your board, and only ${list.owner} can share it with you again.`}
                  </span>
                  <span class="flex items-center gap-2">
                    <button
                      data-list-leave-confirm={list.id}
                      class="meta min-h-11 rounded-md border border-alarm px-3 text-paper
                             transition hover:bg-alarm/10"
                      onclick={() => leave(list)}
                    >
                      Leave
                    </button>
                    <button
                      class="meta min-h-11 rounded-md border border-white/20 px-3
                             hover:border-white/40"
                      onclick={() => (leaving = null)}
                    >
                      Cancel
                    </button>
                  </span>
                {:else}
                  <button
                    data-list-leave={list.id}
                    disabled={offline}
                    title={hint}
                    class="meta min-h-11 rounded-md border border-white/15 px-3
                           hover:border-ember disabled:cursor-not-allowed disabled:opacity-40"
                    onclick={() => (leaving = list.id)}
                  >
                    Leave
                  </button>
                {/if}
              </div>
            {:else}
              <!-- Each of the four below is its own flex container, and the
                   three that hold a control only some rows have are drawn
                   **empty** rather than skipped: the colours started at x=822
                   on an ordinary row and x=864 on a system one, because the
                   reorder arrows were only there on one of the two. A slot of
                   the same width on every row is what lines the swatches up
                   down the page, the new-list row included. -->
              <div class="flex basis-full flex-wrap items-center gap-2 sm:basis-auto">
                <!-- The same six tokens a project chooses from, and the same
                     markup: `CHIP_COLOURS` is shared now, so a list's colour
                     and a project's mean the same thing in every chart and on
                     every card.

                     44px of hit target around a 24px dot, which is the
                     technique the task card's tickbox uses: the drawing did not
                     change and the button did. `flex-wrap` is the safety net —
                     six targets need 264px, and a narrower screen than this app
                     is tested at should wrap them rather than scroll the page
                     sideways. -->
                <span
                  data-swatches
                  role="group"
                  aria-label={`Colour for ${list.name}`}
                  class="flex flex-wrap items-center"
                >
                  {#each CHIP_COLOURS as colour (colour)}
                    <button
                      data-list-colour={`${list.id}:${colour}`}
                      aria-label={`Colour ${colour} for ${list.name}`}
                      aria-pressed={list.colour === colour}
                      disabled={offline}
                      title={hint}
                      class="flex size-11 shrink-0 items-center justify-center
                             disabled:cursor-not-allowed disabled:opacity-30"
                      onclick={() => save(list, { colour })}
                    >
                      <span
                        class="size-6 rounded-full border-2 transition
                               {list.colour === colour
                          ? 'border-paper'
                          : 'border-transparent hover:border-white/40'}"
                        style:background={`var(--color-${colour})`}
                      ></span>
                    </button>
                  {/each}
                </span>

                <!-- Hidden below `sm` when it is empty, and only then: the slot
                     exists to line the swatches up when the controls share the
                     row with the name, and a 92px hole on a phone is a hole
                     with nothing to align. -->
                <span
                  class="{system ? 'hidden sm:flex' : 'flex'} w-23 shrink-0 items-center
                         justify-end gap-1"
                >
                  {#if !system}
                    <button
                      class="meta flex size-11 items-center justify-center rounded-md border
                             border-white/15 hover:border-white/40
                             disabled:cursor-not-allowed disabled:opacity-30"
                      data-list-up={list.id}
                      aria-label={`Move ${list.name} earlier`}
                      disabled={offline || spot === 0}
                      title={hint}
                      onclick={() => move(list, -1)}
                    >
                      ↑
                    </button>
                    <button
                      class="meta flex size-11 items-center justify-center rounded-md border
                             border-white/15 hover:border-white/40
                             disabled:cursor-not-allowed disabled:opacity-30"
                      data-list-down={list.id}
                      aria-label={`Move ${list.name} later`}
                      disabled={offline || spot === ordinary.length - 1}
                      title={hint}
                      onclick={() => move(list, 1)}
                    >
                      ↓
                    </button>
                  {/if}
                </span>

                <!-- A word, not an icon: the owner looked for a way to share and
                     did not find one. Never on the inbox or the archive, which
                     the server refuses to share, and so an empty slot there. -->
                <span
                  class="{system ? 'hidden sm:flex' : 'flex'} w-20 shrink-0 items-center
                         justify-end"
                >
                  {#if !system}
                    <button
                      data-list-share={list.id}
                      aria-expanded={sharing === list.id}
                      class="meta flex min-h-11 w-full items-center justify-center rounded-md
                             border px-3 transition hover:border-white/40
                             {sharing === list.id
                        ? 'border-white/40 bg-dusk/10'
                        : 'border-white/15'}"
                      onclick={() => toggleSharing(list)}
                    >
                      Share
                    </button>
                  {/if}
                </span>

                {#if confirming === list.id}
                  <!-- The question names the number it will take with it,
                       because that is the part somebody cannot see: a list
                       looks the same whether it holds nothing or forty. Prose,
                       so it is not a `.meta` — a sentence in capitals ran to
                       four lines at 320 — and its own group, so the caption may
                       take a line while the two buttons it labels stay side by
                       side. -->
                  <div class="flex basis-full flex-wrap items-center gap-2">
                    <span class="flex-1 basis-full text-sm text-haze sm:basis-auto"
                          data-list-confirm={list.id}>
                      Delete {list.name} and its {held.all}
                      {held.all === 1 ? 'task' : 'tasks'}?
                      {#if list.shared}Everyone it is shared with loses it too.{/if}
                    </span>
                    <span class="flex items-center gap-2">
                      <button
                        data-list-delete-confirm={list.id}
                        class="meta min-h-11 rounded-md border border-alarm px-3 text-paper
                               transition hover:bg-alarm/10"
                        onclick={() => remove(list)}
                      >
                        Delete
                      </button>
                      <button
                        class="meta min-h-11 rounded-md border border-white/20 px-3
                               hover:border-white/40"
                        onclick={() => (confirming = null)}
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                {:else}
                  <span
                    class="{system ? 'hidden sm:flex' : 'flex'} w-11 shrink-0 items-center
                           justify-end"
                  >
                    {#if !system}
                      <button
                        data-list-delete={list.id}
                        disabled={offline}
                        title={hint || 'Delete list'}
                        aria-label={`Delete ${list.name}`}
                        class="meta flex size-11 items-center justify-center rounded-md border
                               border-white/15 hover:border-ember
                               disabled:cursor-not-allowed disabled:opacity-40"
                        onclick={() => (confirming = list.id)}
                      >
                        <IconBin />
                      </button>
                    {/if}
                  </span>
                {/if}
              </div>
            {/if}
          </div>

          {#if sharing === list.id && !system && !foreign}
            <!-- Under the row it belongs to rather than in a dialog: it is two
                 controls and a short roster, and the row's own name is the
                 heading it needs. -->
            <div
              class="mt-3 flex flex-col gap-3 border-t border-white/10 pt-3"
              data-share-panel={list.id}
            >
              <form
                class="flex flex-wrap items-center gap-2"
                onsubmit={(event) => (event.preventDefault(), invite(list))}
              >
                <input
                  data-share-username={list.id}
                  bind:value={invitee}
                  oninput={() => (inviteError = null)}
                  placeholder="Username"
                  aria-label={`Share “${list.name}” with`}
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck="false"
                  disabled={offline}
                  title={hint}
                  class="min-h-11 min-w-0 flex-1 basis-40 rounded-md border border-white/15
                         bg-ink px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
                />
                <button
                  type="submit"
                  data-share-add={list.id}
                  disabled={offline || !invitee.trim()}
                  title={hint}
                  class="meta min-h-11 rounded-md border border-white/15 px-4
                         hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Add
                </button>
              </form>
              {#if inviteError}
                <p class="text-sm text-alarm" role="alert" data-share-error={list.id}>
                  {inviteError}
                </p>
              {/if}
              {#if list.members?.length}
                <ul class="flex flex-col gap-1">
                  {#each list.members as name (name)}
                    <li
                      class="flex items-center justify-between gap-2"
                      data-list-member={`${list.id}:${name}`}
                    >
                      <span class="min-w-0 text-sm break-words">{name}</span>
                      <button
                        data-list-member-remove={`${list.id}:${name}`}
                        aria-label={`Stop sharing “${list.name}” with “${name}”`}
                        disabled={offline}
                        title={hint || 'Stop sharing'}
                        class="meta flex size-11 shrink-0 items-center justify-center rounded-md
                               border border-white/15 hover:border-ember
                               disabled:cursor-not-allowed disabled:opacity-40"
                        onclick={() => stopSharing(list, name)}
                      >
                        ✕
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="text-sm text-haze">
                  Everyone you add sees this list and can add, tick, move and delete its
                  tasks. Only you rename, recolour or delete it.
                </p>
              {/if}
            </div>
          {/if}
        </li>
      {:else}
        <li class="rounded-lg border border-white/10 bg-ink-soft px-5 py-8 text-haze">
          This account has no lists yet. They are made on the server, so this
          needs a connection once.
        </li>
      {/each}
    </ul>

    <!-- The same groups as a row above, in the same order and at the same
         widths, so the swatches and the `+` line up with the rows they will
         join. The padding and the transparent border are part of that: without
         them this row is 21px wider than a list row — a card's inset and its
         1px border — and the alignment is out by exactly that. -->
    <form
      class="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-transparent
             px-3 sm:px-5"
      onsubmit={(event) => (event.preventDefault(), add())}
    >
      <div class="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <span
          class="size-3 shrink-0 rounded-full"
          style:background={chipColour(chosenColour)}
          aria-hidden="true"
        ></span>
        <input
          bind:value={newList}
          data-new-list
          placeholder="New list"
          aria-label="New list"
          maxlength="60"
          class="min-h-11 w-full min-w-0 flex-1 rounded-md border border-white/15 bg-ink-soft
                 px-3 py-2 text-sm"
        />
      </div>
      <div class="flex basis-full flex-wrap items-center gap-2 sm:basis-auto">
        <span
          data-swatches
          class="flex flex-wrap items-center"
          role="group"
          aria-label="Colour for the new list"
        >
          {#each CHIP_COLOURS as colour (colour)}
            <button
              type="button"
              data-new-list-colour={colour}
              aria-label={`New list in ${colour}`}
              aria-pressed={chosenColour === colour}
              class="flex size-11 shrink-0 items-center justify-center"
              onclick={() => (newColour = colour)}
            >
              <span
                class="size-6 rounded-full border-2 transition
                       {chosenColour === colour
                  ? 'border-paper'
                  : 'border-transparent hover:border-white/40'}"
                style:background={`var(--color-${colour})`}
              ></span>
            </button>
          {/each}
        </span>
        <span class="hidden w-23 shrink-0 sm:block" aria-hidden="true"></span>
        <span class="hidden w-20 shrink-0 sm:block" aria-hidden="true"></span>
        <span class="flex w-11 shrink-0 items-center justify-end">
          <button
            type="submit"
            data-new-list-add
            disabled={offline || !newList.trim()}
            title={hint || 'Add'}
            aria-label="Add"
            class="meta flex size-11 items-center justify-center rounded-md border
                   border-white/15 hover:border-white/40
                   disabled:cursor-not-allowed disabled:opacity-30"
          >
            <IconPlus />
          </button>
        </span>
      </div>
    </form>

    <!-- Prose, and so not a `.meta`: three sentences came out as six lines of
         capitals at 320, because `.meta` sets its case unlayered and the
         `normal-case` beside it was dead CSS. The same treatment every other
         caption in this app uses for a sentence. -->
    <p class="mt-4 text-sm text-haze" data-lists-caption>
      The inbox and the archive cannot be deleted — every account has exactly
      one of each — but both can be renamed and recoloured. Deleting an ordinary
      list takes its tasks with it, and leaves anything already archived alone.
    </p>
  {/if}
</section>
