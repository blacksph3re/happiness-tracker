<script>
  import { api, tryApi } from '../lib/api.js'
  import { pushToast } from '../lib/toasts.js'

  let users = $state([])
  let catalogues = $state([])
  let me = $state(null)
  let loading = $state(true)
  let draft = $state({ username: '', password: '', is_admin: false, is_editor: false })

  $effect(() => {
    load()
  })

  async function load() {
    try {
      me = await tryApi('/me')
      users = (await tryApi('/users')) ?? []
      catalogues = (await tryApi('/catalogues')) ?? []
    } finally {
      loading = false
    }
  }

  async function createUser(event) {
    event.preventDefault()
    try {
      await api('/users', {
        method: 'POST',
        body: { ...draft, default_catalogue_id: catalogues[0]?.id ?? null },
      })
      pushToast(`Created ${draft.username}`, 'ok')
      draft = { username: '', password: '', is_admin: false, is_editor: false }
      users = (await tryApi('/users')) ?? []
    } catch (error) {
      pushToast(error.message)
    }
  }

  async function toggle(user, field) {
    try {
      await api(`/users/${user.id}`, { method: 'PUT', body: { [field]: !user[field] } })
      users = (await tryApi('/users')) ?? []
    } catch (error) {
      // The server refuses to let the last admin demote themselves.
      pushToast(error.message)
    }
  }

  async function remove(user) {
    if (!confirm(`Delete ${user.username} and every answer they recorded?`)) return
    try {
      await api(`/users/${user.id}`, { method: 'DELETE' })
      users = (await tryApi('/users')) ?? []
      pushToast(`Deleted ${user.username}`, 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }

  async function resetPassword(user) {
    const new_password = prompt(`New password for ${user.username}`)
    if (!new_password) return
    try {
      await api(`/users/${user.id}/password`, { method: 'PUT', body: { new_password } })
      pushToast(`Password reset for ${user.username}`, 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }
</script>

<section class="mx-auto w-full max-w-4xl px-5 py-8">
  <p class="meta">Who can sign in</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">People</h1>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each users as user (user.id)}
        <li
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                 border-white/10 bg-ink-soft px-5 py-4"
        >
          <div>
            <p class="font-medium">
              {user.username}
              {#if user.id === me?.id}<span class="meta ml-2">you</span>{/if}
            </p>
            <p class="meta mt-1">
              {[user.is_admin && 'manages people', user.is_editor && 'edits questions']
                .filter(Boolean)
                .join(' · ') || 'answers only'}
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
              onclick={() => toggle(user, 'is_admin')}>
              {user.is_admin ? 'Revoke people' : 'Grant people'}
            </button>
            <button class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
              onclick={() => toggle(user, 'is_editor')}>
              {user.is_editor ? 'Revoke questions' : 'Grant questions'}
            </button>
            <button class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
              onclick={() => resetPassword(user)}>Reset password</button>
            {#if user.id !== me?.id}
              <button class="meta rounded-md border border-ember/40 px-3 py-2 text-ember
                             hover:border-ember"
                onclick={() => remove(user)}>Delete</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <form class="mt-8 rounded-xl border border-white/10 bg-ink-soft p-6" onsubmit={createUser}>
      <h2 class="font-semibold">Add someone</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1.5">
          <span class="meta">Username</span>
          <input bind:value={draft.username} required autocomplete="off"
            class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="meta">Password</span>
          <input type="password" bind:value={draft.password} required autocomplete="new-password"
            minlength={me?.password_min_length}
            class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
          {#if me?.password_min_length}
            <span class="meta normal-case">
              At least {me.password_min_length} characters
            </span>
          {/if}
        </label>
      </div>
      <div class="mt-4 flex flex-wrap gap-5">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={draft.is_admin} class="accent-ember" />
          Can manage people
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={draft.is_editor} class="accent-ember" />
          Can edit questions
        </label>
      </div>
      <button type="submit" class="mt-5 rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift">
        Add person
      </button>
    </form>
  {/if}
</section>
