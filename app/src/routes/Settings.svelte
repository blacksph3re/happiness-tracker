<script>
  import { api, tryApi } from '../lib/api.js'
  import { pushToast } from '../lib/toasts.js'

  let me = $state(null)
  let catalogues = $state([])
  let currentPassword = $state('')
  let newPassword = $state('')

  $effect(() => {
    load()
  })

  async function load() {
    me = await tryApi('/me')
    catalogues = (await tryApi('/catalogues')) ?? []
  }

  async function chooseCatalogue(event) {
    const updated = await tryApi('/me/default-catalogue', {
      method: 'PUT',
      body: { catalogue_id: Number(event.target.value) },
    })
    if (updated) {
      me = updated
      pushToast('Default catalogue changed', 'ok')
    }
  }

  async function changePassword(event) {
    event.preventDefault()
    try {
      await api('/me/password', {
        method: 'PUT',
        body: { current_password: currentPassword, new_password: newPassword },
      })
      currentPassword = ''
      newPassword = ''
      pushToast('Password changed', 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }
</script>

<section class="mx-auto w-full max-w-2xl px-5 py-8">
  <p class="meta">Signed in as {me?.username ?? '…'}</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">Settings</h1>

  <div class="rounded-xl border border-white/10 bg-ink-soft p-6">
    <h2 class="font-semibold">Default catalogue</h2>
    <p class="mt-1 text-sm text-haze">The set of questions you answer each day.</p>
    <select
      class="mt-3 w-full rounded-lg border border-white/15 bg-ink px-4 py-3"
      value={me?.default_catalogue_id ?? ''}
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
    <button type="submit" class="mt-4 rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift">
      Change password
    </button>
  </form>
</section>
