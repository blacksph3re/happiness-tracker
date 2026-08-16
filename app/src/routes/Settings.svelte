<script>
  import AdminOffline from '../lib/AdminOffline.svelte'
  import { attempt, unwrap } from '../lib/api.js'
  import { changeMyPassword, setMyDefaultCatalogue } from '../lib/generated/sdk.gen'
  import { resource } from '../lib/resource.svelte.js'
  import { catalogues as catalogueStore, ensureCatalogues, ensureMe, me as meStore } from '../lib/store.js'
  import { connection } from '../lib/sync.js'
  import { pushToast } from '../lib/toasts.js'

  /** Nothing on this page queues, so nothing on it is offered without a connection. */
  const offline = $derived($connection !== 'online')

  let currentPassword = $state('')
  let newPassword = $state('')

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
      onchange={chooseCatalogue}
    >
      {#each catalogues as catalogue (catalogue.id)}
        <option value={catalogue.id}>{catalogue.name}</option>
      {/each}
    </select>
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
      class="mt-4 rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift
             disabled:cursor-not-allowed disabled:opacity-40"
    >
      Change password
    </button>
  </form>
</section>
