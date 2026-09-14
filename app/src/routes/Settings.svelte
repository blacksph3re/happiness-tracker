<script>
  import Frame from '../lib/Frame.svelte'
  import AdminOffline, { OFFLINE_HINT } from '../lib/AdminOffline.svelte'
  import { attempt, clearTokens, unwrap } from '../lib/api.js'
  import { formatBytes, formatUptime } from '../lib/format.js'
  import {
    beginTotpEnrolment,
    changeMyPassword,
    confirmTotpEnrolment,
    disableTotp,
    getServerMetrics,
    setMyDefaultCatalogue,
  } from '../lib/generated/sdk.gen'
  import IconBin from '../lib/IconBin.svelte'
  import QrCode from '../lib/QrCode.svelte'
  import { resource } from '../lib/resource.svelte.js'
  import { APPEARANCES, appearance, chooseAppearance } from '../lib/theme.svelte.js'
  import { forceUpdate } from '../lib/updates.js'
  import {
    disablePush,
    enablePush,
    pushSupport,
    readPushSupport,
  } from '../lib/push.js'
  import {
    catalogues as catalogueStore,
    ensureCatalogues,
    ensureMe,
    ensurePreferences,
    me as meStore,
    persistPreferences,
    preferenceSection,
    preferences as preferenceStore,
  } from '../lib/store.js'
  import {
    DEFAULT_BREAK_MINUTES,
    DEFAULT_FOCUS_MINUTES,
    MAX_MINUTES,
  } from '../lib/focus-mode.js'
  import { AMBIENCES, CHIMES, playChime } from '../lib/pomodoro/sounds.js'
  import {
    PRIORITIES,
    PRIORITY_LABELS,
    bucketHint,
    cleanBuckets,
    cleanSplit,
    importantSplit,
    sizeBuckets,
    todoSettings,
    urgentDays,
  } from '../lib/todo-settings.js'
  import { connection } from '../lib/sync.js'
  import { navigate } from '../lib/router.js'
  import { pushToast } from '../lib/toasts.js'

  const focus = $derived(preferenceSection($preferenceStore, 'focus'))

  /** The whole `todos` section, view state included, so a save keeps the rest. */
  const todoSection = $derived(preferenceSection($preferenceStore, 'todos'))

  /** The three things the board is configured by, validated and complete. */
  const todo = $derived(todoSettings(todoSection))

  /** Why the last todo edit was refused, or null when none was. */
  let refused = $state(null)

  /**
   * Save the board's settings, or refuse them.
   *
   * **Refused rather than absorbed**, which is the whole reason `cleanSplit`
   * and `cleanBuckets` are exported: every reader of these settings falls back
   * to the defaults for a value it cannot use, so a set saved in that state
   * would come back as the defaults and the control would have silently done
   * the opposite of what it was told. Asked first, and the caller puts the
   * field back.
   *
   * The section is spread through, not replaced: it also carries the list,
   * grouping and layout the board is remembering, and a page that saved only
   * its own half would throw the other away.
   *
   * @param {object} patch The parts of `TodoSettings` that changed.
   * @returns {boolean} Whether it was saved.
   */
  function saveTodoSettings(patch) {
    const wanted = { ...todo, ...patch }
    if (!cleanSplit(wanted.important)) {
      refused = 'At least one priority has to count as important, or the matrix has two columns nothing can reach.'
      return false
    }
    if (!Number.isInteger(wanted.urgent_days) || wanted.urgent_days < 0) {
      refused = 'The urgency window is a whole number of days, zero or more.'
      return false
    }
    if (!cleanBuckets(wanted.buckets)) {
      refused =
        'The buckets have to run from zero upwards with no gap and no overlap, and every centre has to fall inside its own bucket.'
      return false
    }
    refused = null
    persistPreferences('todos', { ...todoSection, settings: wanted })
    return true
  }

  /**
   * Turn one priority's importance on or off.
   *
   * @param {string} priority
   * @param {boolean} wanted
   * @returns {boolean} Whether it was saved.
   */
  function chooseImportant(priority, wanted) {
    const split = PRIORITIES.filter((one) =>
      one === priority ? wanted : importantSplit(todo).includes(one)
    )
    return saveTodoSettings({ important: split })
  }

  /**
   * Change one field of one size bucket.
   *
   * A bucket's **upper** edge is the editable one, and setting it moves the
   * next bucket's lower edge with it. That is not a shortcut: the set has to
   * cover every minute from zero upwards exactly once or a task with a duration
   * has no column, and two independently edited numbers that have to be equal
   * is a rule nobody can satisfy one keystroke at a time. So a boundary is one
   * number drawn twice, and `from` is read-only.
   *
   * @param {number} at Which bucket, indexed as drawn.
   * @param {string} field `label`, `max` or `centre`.
   * @param {string|number} value What was typed.
   * @returns {boolean} Whether it was saved.
   */
  function chooseBucket(at, field, value) {
    const buckets = sizeBuckets(todo).map((one) => ({ ...one }))
    if (field === 'label') {
      buckets[at].label = String(value).trim()
    } else {
      const number = Number(value)
      if (!Number.isFinite(number)) {
        refused = 'That is not a number of minutes.'
        return false
      }
      buckets[at][field] = Math.round(number)
      if (field === 'max' && buckets[at + 1]) buckets[at + 1].min = Math.round(number)
    }
    return saveTodoSettings({ buckets })
  }

  /** Why the notification switch is unavailable, or null when it is not. */
  const pushBlocked = $derived(
    !$pushSupport.available
      ? 'Notifications need the app added to the Home Screen. In a browser tab there is no way to receive one.'
      : !$pushSupport.configured
        ? 'This server has no notification keys, so it cannot send any.'
        : $pushSupport.permission === 'denied'
          ? 'Notifications are blocked for this site in the browser’s own settings, which is the only place that can undo it.'
          : null
  )

  let pushBusy = $state(false)

  $effect(() => {
    // Reads the existing permission and asks for none, so it shows no prompt.
    readPushSupport()
  })

  /** Turn notifications on or off. Called from a click, which is required. */
  async function togglePush() {
    pushBusy = true
    try {
      if ($pushSupport.subscribed) {
        await disablePush()
        return
      }
      const { ok, reason } = await enablePush()
      if (!ok) pushToast(reason)
    } finally {
      pushBusy = false
    }
  }

  $effect(() => {
    ensurePreferences()
  })

  /**
   * Save one focus preference, leaving the others alone.
   *
   * These live in the preferences document rather than in a column: the
   * backend has no opinion about what a pomodoro sounds like, and adding one
   * would be a migration for a dropdown.
   */
  function chooseFocus(key, value) {
    // Stored as a number so nothing downstream has to parse a field's string,
    // and left alone while it is empty: clamping mid-typing turns backspacing
    // "25" into "2" and then into a fight with the cursor.
    const stored = key.endsWith('_minutes') ? Number(value) : value
    if (key.endsWith('_minutes') && !Number.isFinite(stored)) return
    persistPreferences('focus', { ...focus, [key]: stored })
    // Played on selection, because the only way to choose a sound is to hear
    // it — and a chime you first meet at the end of a focus block is one you
    // find out you dislike at the worst moment.
    if (key === 'chime') playChime(value)
  }

  /** Nothing on this page queues, so nothing on it is offered without a connection. */
  const offline = $derived($connection !== 'online')

  /** Set on every control the connection is holding down, and on no other. */
  const hint = $derived(offline ? OFFLINE_HINT : undefined)

  let currentPassword = $state('')
  let newPassword = $state('')

  /** The enrolment in progress, or null when none has been started. */
  let enrolling = $state(null)

  /** The digits typed into whichever second-factor form is open. */
  let code = $state('')

  /** Whether the disable form is open, so it takes a deliberate second click. */
  let removing = $state(false)

  const enrolled = $derived(me?.totp_enabled === true)

  /**
   * The version this bundle was built as.
   *
   * Baked in by Vite from `package.json`, so it describes the code actually
   * running in this browser rather than what the server happens to be serving
   * now — which is the honest answer when a cached worker is a release behind.
   */
  const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

  // Administrators only, and only worth asking for when the page is open.
  const metrics = resource(
    () => ($meStore?.is_admin ? 'admin' : null),
    (who) => (who ? attempt(() => getServerMetrics()) : null),
    { name: 'server metrics' }
  )
  const server = $derived(metrics.data ?? null)

  /**
   * Whether the served version differs from the one this bundle was built as.
   *
   * Only ever true for a browser holding a worker from before the last deploy.
   * Worth saying rather than showing two numbers with no explanation.
   */
  const behind = $derived(Boolean(server) && server.version !== appVersion)

  /**
   * Ask for a secret and show it.
   *
   * The secret is held in component state and nowhere else. It is only a secret
   * until it is confirmed — after that the server has it and the phone has it,
   * and this page has no further use for it.
   */
  async function beginEnrolment() {
    code = ''
    enrolling = await attempt(() => beginTotpEnrolment())
  }

  async function confirmEnrolment(event) {
    event.preventDefault()
    try {
      await unwrap(() => confirmTotpEnrolment({ body: { code: code.trim() } }))
    } catch (failure) {
      pushToast(failure.message)
      return
    }
    enrolling = null
    code = ''
    // Re-read rather than assumed: `totp_enabled` is what every control here
    // switches on, and guessing it would be this page disagreeing with the
    // server about whether the account is protected.
    await ensureMe({ force: true })
    pushToast('Second factor on', 'ok')
  }

  /**
   * Turn the second factor off, which signs this session out with it.
   *
   * The server bumps the token version, so the credentials in hand stop working
   * the moment this returns. Navigating to the login form is not a courtesy —
   * every request after this point would 401, and a page that stayed put would
   * simply appear to break.
   */
  async function remove(event) {
    event.preventDefault()
    try {
      await unwrap(() => disableTotp({ body: { code: code.trim() } }))
    } catch (failure) {
      pushToast(failure.message)
      return
    }
    clearTokens()
    navigate('/login')
  }

  // Through `resource` rather than an effect that assigns what this component
  // reads: nothing here changes to re-trigger a load today, which is the only
  // reason the effect was safe, and that is a property nobody was maintaining.
  const loaded = resource(
    () => null,
    () => Promise.all([ensureMe(), ensureCatalogues()]),
    { name: 'settings' }
  )

  // Read from the stores the load fills, so a change made elsewhere — the
  // catalogue list, the account after a rename — is reflected without a refetch.
  const me = $derived($meStore)
  const catalogues = $derived($catalogueStore ?? [])

  async function chooseCatalogue(event) {
    const updated = await attempt(() =>
      setMyDefaultCatalogue({ body: { catalogue_id: Number(event.target.value) } })
    )
    if (updated) {
      meStore.set(updated)
      pushToast('Default catalogue changed', 'ok')
    }
  }

  async function changePassword(event) {
    event.preventDefault()
    try {
      await unwrap(() =>
        changeMyPassword({
          body: { current_password: currentPassword, new_password: newPassword },
        })
      )
      currentPassword = ''
      newPassword = ''
      pushToast('Password changed', 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }
</script>

<Frame column="max-w-2xl">
<section class="max-w-2xl">
  <p class="meta">Signed in as {loaded.loading ? '…' : (me?.username ?? 'nobody')}</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">Settings</h1>

  <AdminOffline />

  <!-- One switch for every control below that talks to the server, rather
       than `disabled={offline}` on each: four of twenty-eight carried it, and
       an unticked priority offline looked applied, said nothing, and came back
       ticked after a reload. A disabled fieldset disables every descendant, so
       a control added later cannot be the one that forgot. About stays
       outside, since reloading to update needs no answer from the server. -->
  <fieldset disabled={offline} title={hint} class="m-0 min-w-0 border-0 p-0" data-needs-server>

  <div class="rounded-xl border border-white/10 bg-ink-soft p-6">
    <h2 class="font-semibold">Default catalogue</h2>
    <p class="mt-1 text-sm text-haze">The set of questions you answer each day.</p>
    <select
      class="mt-3 w-full rounded-lg border border-white/15 bg-ink px-4 py-3
             disabled:cursor-not-allowed disabled:opacity-40"
      value={me?.default_catalogue_id ?? ''}
      disabled={offline}
      title={hint}
      onchange={chooseCatalogue}
    >
      {#each catalogues as catalogue (catalogue.id)}
        <option value={catalogue.id}>{catalogue.name}</option>
      {/each}
    </select>
  </div>

  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-focus-settings>
    <h2 class="font-semibold">Focus</h2>
    <p class="mt-1 text-sm text-haze">
      Changing these does not affect past pomodoros.
    </p>

    <div class="mt-4 grid gap-4 sm:grid-cols-2">
      <div>
        <label class="meta block" for="focus-minutes">Focus, minutes</label>
        <input
          id="focus-minutes"
          type="number"
          min="1"
          max={MAX_MINUTES}
          step="1"
          class="numeral mt-2 w-full rounded-lg border border-white/15 bg-ink px-4 py-3"
          value={focus.focus_minutes ?? DEFAULT_FOCUS_MINUTES}
          oninput={(event) => chooseFocus('focus_minutes', event.currentTarget.value)}
        />
      </div>
      <div>
        <label class="meta block" for="break-minutes">Break, minutes</label>
        <input
          id="break-minutes"
          type="number"
          min="0"
          max={MAX_MINUTES}
          step="1"
          class="numeral mt-2 w-full rounded-lg border border-white/15 bg-ink px-4 py-3"
          value={focus.break_minutes ?? DEFAULT_BREAK_MINUTES}
          oninput={(event) => chooseFocus('break_minutes', event.currentTarget.value)}
        />
      </div>
    </div>
    <p class="meta mt-2 normal-case text-haze">
      0 means no break.
    </p>

    <label class="meta mt-4 block" for="focus-chime">Sound when a phase ends</label>
    <select
      id="focus-chime"
      class="mt-2 w-full rounded-lg border border-white/15 bg-ink px-4 py-3"
      value={focus.chime ?? 'none'}
      onchange={(event) => chooseFocus('chime', event.currentTarget.value)}
    >
      {#each CHIMES as chime (chime.id)}
        <option value={chime.id}>{chime.label}</option>
      {/each}
    </select>

    <label class="meta mt-4 block" for="focus-ambience">Focus sound</label>
    <select
      id="focus-ambience"
      class="mt-2 w-full rounded-lg border border-white/15 bg-ink px-4 py-3"
      value={focus.ambience ?? 'none'}
      onchange={(event) => chooseFocus('ambience', event.currentTarget.value)}
    >
      {#each AMBIENCES as ambience (ambience.id)}
        <option value={ambience.id}>{ambience.label}</option>
      {/each}
    </select>
    <p class="mt-3 text-sm text-haze">
      With no sound, a pomodoro that ends while the app is closed is reported when
      you return.
    </p>
  </div>

  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-todo-settings>
    <h2 class="font-semibold">Todos</h2>
    <p class="mt-1 text-sm text-haze">
      How tasks fall into the Eisenhower and Size views. Changes apply to every
      task, past ones included.
    </p>

    <!-- Labelled with what it means, which is the smoothing-slider lesson: a
         control that is not on screen still applies, and these apply on a page
         that does not draw them. -->
    <p class="meta mt-5">Important · {importantSplit(todo).map((one) => PRIORITY_LABELS[one].toLowerCase()).join(', ')}</p>
    <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
      {#each PRIORITIES as priority (priority)}
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            data-important={priority}
            checked={importantSplit(todo).includes(priority)}
            onchange={(event) => {
              const wanted = event.currentTarget.checked
              if (!chooseImportant(priority, wanted)) event.currentTarget.checked = !wanted
            }}
          />
          <span class="text-sm">{PRIORITY_LABELS[priority]}</span>
        </label>
      {/each}
    </div>
    <!-- A sentence, so not a `.meta`: its case is set unlayered and the
         `normal-case` beside it was dead CSS, which is three paragraphs of
         prose in capitals on the page this section is read on. -->
    <p class="mt-2 text-sm text-haze" data-todo-note>
      A task with no priority is never important.
    </p>

    <label class="meta mt-5 block" for="todo-urgent">
      Urgent · due within {urgentDays(todo)} {urgentDays(todo) === 1 ? 'day' : 'days'}
    </label>
    <input
      id="todo-urgent"
      type="number"
      min="0"
      max="365"
      step="1"
      data-urgent-days
      class="numeral mt-2 w-32 rounded-lg border border-white/15 bg-ink px-4 py-3"
      value={urgentDays(todo)}
      onchange={(event) => {
        const wanted = Number(event.currentTarget.value)
        if (!saveTodoSettings({ urgent_days: Math.round(wanted) })) {
          event.currentTarget.value = urgentDays(todo)
        }
      }}
    />
    <p class="mt-2 text-sm text-haze" data-todo-note>
      A task with no due date is never urgent.
    </p>

    <p class="meta mt-5">Sizes</p>
    <p class="mt-1 text-sm text-haze" data-todo-note>
      Dropping a task into a size sets its estimate to the centre.
    </p>
    <!-- Each bucket is a box of its own, and its hint always takes its own line
         inside it. Under one wrapping row the two shortest hints stayed inline
         and the two longest wrapped — 12px under their own fields and **8px
         above the next bucket's Name label**, so two of the four read as the
         neighbour's caption. `basis-full` is what makes the hint's line a
         decision rather than an accident of how long the text came out, and the
         border is what says which fields it is about. -->
    <div class="mt-3 flex flex-col gap-3">
      {#each sizeBuckets(todo) as bucket, at (bucket.id)}
        <div
          class="flex flex-wrap items-end gap-x-3 gap-y-1.5 rounded-lg border border-white/10
                 px-3 py-3"
          data-bucket={bucket.id}
        >
          <label class="flex flex-col gap-1.5">
            <span class="meta">Name</span>
            <input
              data-bucket-label={bucket.id}
              value={bucket.label}
              maxlength="40"
              class="w-40 rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
              onchange={(event) => {
                if (!chooseBucket(at, 'label', event.currentTarget.value)) {
                  event.currentTarget.value = bucket.label
                }
              }}
            />
          </label>
          {#if bucket.min === null}
            <!-- The bucket that is not a range. Something has to answer "no
                 estimate at all", and it is fixed because it has nothing to
                 configure: no edges, and a drop into it writes no duration. -->
            <p class="py-2 text-sm text-haze" data-todo-note>No estimate.</p>
          {:else}
            <label class="flex flex-col gap-1.5">
              <span class="meta">From</span>
              <input
                data-bucket-from={bucket.id}
                class="numeral w-24 rounded-lg border border-white/15 bg-ink px-3 py-2
                       text-sm opacity-60"
                value={bucket.min}
                disabled
                aria-label={`${bucket.label} starts at`}
              />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="meta">To</span>
              {#if bucket.max === null}
                <input
                  data-bucket-to={bucket.id}
                  class="numeral w-24 rounded-lg border border-white/15 bg-ink px-3 py-2
                         text-sm opacity-60"
                  value="∞"
                  disabled
                  aria-label={`${bucket.label} has no upper edge`}
                />
              {:else}
                <input
                  type="number"
                  min="1"
                  step="5"
                  data-bucket-to={bucket.id}
                  aria-label={`${bucket.label} ends at`}
                  class="numeral w-24 rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                  value={bucket.max}
                  onchange={(event) => {
                    if (!chooseBucket(at, 'max', event.currentTarget.value)) {
                      event.currentTarget.value = bucket.max
                    }
                  }}
                />
              {/if}
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="meta">Centre</span>
              <input
                type="number"
                min="0"
                step="5"
                data-bucket-centre={bucket.id}
                aria-label={`${bucket.label} centre`}
                class="numeral w-24 rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm"
                value={bucket.centre}
                onchange={(event) => {
                  if (!chooseBucket(at, 'centre', event.currentTarget.value)) {
                    event.currentTarget.value = bucket.centre
                  }
                }}
              />
            </label>
            <!-- The same sentence the column heading draws, from the same
                 function: two spellings of *1h–4h → 2h* is how two numbers on
                 one screen come to disagree, and this one is on two screens. -->
            <p class="meta basis-full normal-case" data-bucket-says={bucket.id}>
              {bucketHint(bucket)}
            </p>
          {/if}
        </div>
      {/each}
    </div>

    {#if refused}
      <!-- Said rather than swallowed. The field has already gone back to what
           was stored; without this the only evidence would be a number that
           declined to change. -->
      <p class="mt-3 text-sm text-alarm" data-todo-refused>{refused}</p>
    {/if}
  </div>

  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-push>
    <h2 class="font-semibold">Notifications</h2>
    <p class="mt-1 text-sm text-haze">
      Get notified when a focus block ends.
    </p>

    {#if pushBlocked}
      <p class="mt-3 text-sm text-haze" data-push-blocked>{pushBlocked}</p>
    {:else}
      <p class="mt-3 text-sm">
        {$pushSupport.subscribed
          ? 'This device will be notified.'
          : 'This device is not being notified.'}
      </p>
      <button
        data-push-toggle
        class="btn-filled mt-3 disabled:opacity-40"
        disabled={pushBusy}
        onclick={togglePush}
      >
        {$pushSupport.subscribed ? 'Stop notifying this device' : 'Notify this device'}
      </button>
      <p class="meta mt-3 normal-case text-haze">
        Applies to this device only.
      </p>
    {/if}
  </div>

  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-totp>
    <h2 class="font-semibold">Second factor</h2>
    <p class="mt-1 text-sm text-haze">
      A code from your phone, asked for at sign-in.
    </p>

    {#if enrolled}
      <p class="mt-3 text-sm" data-totp-state="on">
        On. Sign-in asks for a code from your authenticator.
      </p>

      {#if removing}
        <form class="mt-4 flex flex-col gap-3" onsubmit={remove}>
          <label class="flex flex-col gap-1.5">
            <span class="meta">A current code, to prove it is you</span>
            <input
              bind:value={code}
              data-totp-code
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="8"
              class="numeral max-w-40 rounded-lg border border-white/15 bg-ink px-4 py-3
                     tracking-[0.3em]"
            />
          </label>
          <!-- Said before it happens rather than discovered afterwards: this
               signs out every device, including the one asking. -->
          <p class="meta normal-case">
            Removing it signs you out everywhere.
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={offline || !code.trim()}
              title={hint}
              class="meta flex items-center gap-2 rounded-md border border-ember px-3 py-2
                     text-paper hover:bg-ember/10 disabled:cursor-not-allowed
                     disabled:opacity-40"
            >
              <IconBin class="size-3.5" />
              Remove it
            </button>
            <button
              type="button"
              class="btn-outline meta"
              onclick={() => ((removing = false), (code = ''))}
            >
              Cancel
            </button>
          </div>
        </form>
      {:else}
        <button
          data-totp-remove
          disabled={offline}
          title={hint}
          class="btn-danger meta mt-4 flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
          onclick={() => ((removing = true), (code = ''))}
        >
          <IconBin class="size-3.5" />
          Remove it
        </button>
      {/if}
    {:else if enrolling}
      <div class="mt-4 flex flex-wrap items-start gap-6">
        <QrCode value={enrolling.otpauth_uri} />
        <div class="min-w-0 flex-1 basis-56">
          <p class="meta">Or type it in</p>
          <!-- Broken into fours, because this is read off one screen and typed
               into another. `break-all` so a narrow phone wraps it rather than
               pushing the card sideways. -->
          <p class="numeral mt-1 text-sm break-all" data-totp-secret>
            {enrolling.secret.match(/.{1,4}/g).join(' ')}
          </p>
          <form class="mt-4 flex flex-col gap-3" onsubmit={confirmEnrolment}>
            <label class="flex flex-col gap-1.5">
              <span class="meta">Then the code it shows</span>
              <input
                bind:value={code}
                data-totp-code
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="8"
                class="numeral max-w-40 rounded-lg border border-white/15 bg-ink px-4 py-3
                       tracking-[0.3em]"
              />
            </label>
            <div class="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={offline || !code.trim()}
                title={hint}
                class="btn-filled disabled:cursor-not-allowed disabled:opacity-40"
              >
                Turn it on
              </button>
              <button
                type="button"
                class="btn-outline meta"
                onclick={() => ((enrolling = null), (code = ''))}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
      <!-- The whole reason enrolment has two steps: nothing is demanded at
           sign-in until a code has been proved, so closing this page now leaves
           the account exactly as it was. -->
      <p class="meta mt-4 normal-case">
        Nothing changes until you enter a code.
      </p>
    {:else}
      <p class="mt-3 text-sm" data-totp-state="off">
        Off.
      </p>
      <button
        data-totp-begin
        disabled={offline}
        title={hint}
        class="btn-filled mt-4 disabled:cursor-not-allowed disabled:opacity-40"
        onclick={beginEnrolment}
      >
        Set it up
      </button>
    {/if}
  </div>

  <form class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" onsubmit={changePassword}>
    <h2 class="font-semibold">Change password</h2>
    <label class="mt-3 flex flex-col gap-1.5">
      <span class="meta">Current password</span>
      <input type="password" bind:value={currentPassword} autocomplete="current-password"
        class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
    </label>
    <label class="mt-3 flex flex-col gap-1.5">
      <span class="meta">New password</span>
      <input type="password" bind:value={newPassword} autocomplete="new-password"
        required minlength={me?.password_min_length}
        class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
      {#if me?.password_min_length}
        <span class="meta normal-case">At least {me.password_min_length} characters</span>
      {/if}
    </label>
    <button
      type="submit"
      disabled={offline}
      title={hint}
      class="btn-filled mt-4 disabled:cursor-not-allowed disabled:opacity-40"
    >
      Change password
    </button>
  </form>
  </fieldset>

  <!-- Outside the fieldset: the appearance is kept on this device, so it needs
       no server and works offline like reloading to update does. -->
  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-appearance>
    <h2 class="font-semibold">Appearance</h2>
    <p class="mt-1 text-sm text-haze">
      Applies to this device only.
    </p>
    <!-- Equal cells rather than a wrapping row: at 320 the three labels do not
         fit on one line, and a wrap would leave one alone on the next. -->
    <div class="mt-4 grid grid-cols-3 gap-2" role="group" aria-label="Appearance">
      {#each APPEARANCES as [value, label] (value)}
        <button
          type="button"
          class="meta min-h-11 rounded-md border px-2 py-1 leading-tight transition
                 {appearance.choice === value
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          aria-pressed={appearance.choice === value}
          data-appearance-choice={value}
          onclick={() => chooseAppearance(value)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-about>
    <h2 class="font-semibold">About</h2>
    <dl class="mt-3 flex flex-wrap gap-x-10 gap-y-3">
      <div>
        <dt class="meta">Version</dt>
        <dd class="numeral mt-1" data-app-version>{appVersion}</dd>
      </div>
      {#if behind}
        <!-- Only ever a browser holding a worker from before the last deploy.
             Two bare numbers would raise the question this answers. -->
        <div>
          <dt class="meta">On the server</dt>
          <dd class="numeral mt-1 text-ember">{server.version}</dd>
        </div>
      {/if}
    </dl>
    {#if behind}
      <p class="meta mt-3 normal-case">
        This device is running an older copy.
      </p>
      <!-- The remedy beside the fact. Reading "you are a version behind" and
           being left to work out that a reload is what fixes it — and that an
           ordinary reload may not, because the worker serves its own cache —
           is the page stopping one step short. -->
      <button
        data-force-update
        class="btn-filled mt-3"
        onclick={forceUpdate}
      >
        Reload to update
      </button>
    {/if}

    {#if me?.is_admin}
      <!-- Administrators only: how full a disk is says something about the host
           rather than about anybody's answers. The API enforces it; this only
           keeps the page honest. -->
      <div class="mt-5 border-t border-white/10 pt-4" data-server-metrics>
        <p class="meta">This server</p>
        {#if metrics.loading && !server}
          <p class="meta mt-2 normal-case">Asking…</p>
        {:else if !server}
          <p class="meta mt-2 normal-case">Could not reach the server.</p>
        {:else}
          <dl class="mt-3 flex flex-wrap gap-x-10 gap-y-3">
            <div>
              <dt class="meta">Serving for</dt>
              <dd class="numeral mt-1" data-uptime>
                {formatUptime(server.uptime_seconds)}
              </dd>
            </div>
            <div>
              <dt class="meta">Database</dt>
              <dd class="numeral mt-1">{formatBytes(server.database_bytes)}</dd>
            </div>
            <div>
              <dt class="meta">Disk free</dt>
              <dd class="numeral mt-1" data-disk-free>
                {formatBytes(server.disk.free_bytes)}
                <span class="meta normal-case">
                  of {formatBytes(server.disk.total_bytes)}
                </span>
              </dd>
            </div>
            {#if server.memory}
              <div>
                <dt class="meta">Memory</dt>
                <dd class="numeral mt-1">
                  {formatBytes(server.memory.used_bytes)}
                  {#if server.memory.limit_bytes}
                    <span class="meta normal-case">
                      of {formatBytes(server.memory.limit_bytes)}
                    </span>
                  {/if}
                </dd>
              </div>
            {/if}
          </dl>
          <p class="meta mt-3 normal-case">
            Since the last restart.
          </p>
        {/if}
      </div>
    {/if}
  </div>
</section>
</Frame>

<style>
  /* Dimmed the way the controls that carried `disabled:opacity-40` already
     were. That variant reads the control's own `:disabled`, which a fieldset
     does set, but most controls here never had the class. */
  fieldset:disabled :is(input, select, button) {
    cursor: not-allowed;
    opacity: 0.4;
  }
</style>
