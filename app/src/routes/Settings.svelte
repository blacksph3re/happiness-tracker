<script>
  import AdminOffline, { OFFLINE_HINT } from '../lib/AdminOffline.svelte'
  import { attempt, clearTokens, unwrap } from '../lib/api.js'
  import {
    beginTotpEnrolment,
    changeMyPassword,
    confirmTotpEnrolment,
    disableTotp,
    setMyDefaultCatalogue,
  } from '../lib/generated/sdk.gen'
  import QrCode from '../lib/QrCode.svelte'
  import { resource } from '../lib/resource.svelte.js'
  import { catalogues as catalogueStore, ensureCatalogues, ensureMe, me as meStore } from '../lib/store.js'
  import { connection } from '../lib/sync.js'
  import { navigate } from '../lib/router.js'
  import { pushToast } from '../lib/toasts.js'

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

<section class="mx-auto w-full max-w-2xl px-5 py-8">
  <p class="meta">Signed in as {loaded.loading ? '…' : (me?.username ?? 'nobody')}</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">Settings</h1>

  <AdminOffline does="Your account settings are kept in one place, on the server" />

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

  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-6" data-totp>
    <h2 class="font-semibold">Second factor</h2>
    <p class="mt-1 text-sm text-haze">
      A six-digit code from your phone, on top of the password. Nothing else in the
      app changes — it is asked for at sign-in and nowhere else.
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
            Removing it signs you out everywhere. You will sign back in with the
            password alone.
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={offline || !code.trim()}
              title={hint}
              class="meta rounded-md border border-ember px-3 py-2 text-paper
                     hover:bg-ember/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Remove it
            </button>
            <button
              type="button"
              class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
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
          class="meta mt-4 rounded-md border border-white/15 px-3 py-2 hover:border-ember
                 disabled:cursor-not-allowed disabled:opacity-40"
          onclick={() => ((removing = true), (code = ''))}
        >
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
                class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold
                       hover:bg-dusk-lift disabled:cursor-not-allowed disabled:opacity-40"
              >
                Turn it on
              </button>
              <button
                type="button"
                class="meta rounded-md border border-white/15 px-3 py-2
                       hover:border-white/40"
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
        Nothing changes until you enter a code. Leaving now cannot lock you out.
      </p>
    {:else}
      <p class="mt-3 text-sm" data-totp-state="off">
        Off. Your password is the only thing between the internet and this account.
      </p>
      <button
        data-totp-begin
        disabled={offline}
        title={hint}
        class="mt-4 rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift
               disabled:cursor-not-allowed disabled:opacity-40"
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
      class="mt-4 rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift
             disabled:cursor-not-allowed disabled:opacity-40"
    >
      Change password
    </button>
  </form>
</section>
