<script>
  import AdminOffline, { OFFLINE_HINT } from '../lib/AdminOffline.svelte'
  import { attempt, unwrap } from '../lib/api.js'
  import { resource } from '../lib/resource.svelte.js'
  import {
    clearUserTotp,
    createUser as createUserCall,
    deleteUser,
    listUsers,
    resetUserPassword,
    updateUser,
  } from '../lib/generated/sdk.gen'
  import { ensureCatalogues, ensureMe } from '../lib/store.js'
  import { connection } from '../lib/sync.js'
  import { pushToast } from '../lib/toasts.js'

  /** Accounts are the server's alone: nothing here queues, so nothing here is offered without it. */
  const offline = $derived($connection !== 'online')

  /** Set on every control the connection is holding down, and on no other. */
  const hint = $derived(offline ? OFFLINE_HINT : undefined)

  let draft = $state({ username: '', password: '', is_admin: false, is_editor: false })

  /**
   * Bumped by every write, so the list re-reads after it.
   *
   * The account list is not in the store — it belongs to whoever is
   * administering rather than to the session — so there is nothing to update in
   * place, and a counter in the query is how a write asks for the read again.
   */
  let revision = $state(0)

  // Through `resource` rather than an effect that assigns what this component
  // reads: the effect was safe only because nothing it read ever changed, which
  // stopped being true the moment a write wanted to reload the list.
  const loaded = resource(
    () => revision,
    async () => {
      const [account, list, sets] = await Promise.all([
        ensureMe(),
        attempt(() => listUsers()),
        ensureCatalogues(),
      ])
      return { me: account, users: list ?? [], catalogues: sets ?? [] }
    },
    { name: 'people', initial: { me: null, users: [], catalogues: [] } }
  )

  const loading = $derived(loaded.loading && loaded.data.users.length === 0)
  const me = $derived(loaded.data.me)
  const users = $derived(loaded.data.users)
  const catalogues = $derived(loaded.data.catalogues)

  async function createUser(event) {
    event.preventDefault()
    try {
      await unwrap(() =>
        createUserCall({
          body: { ...draft, default_catalogue_id: catalogues[0]?.id ?? null },
        })
      )
      pushToast(`Created ${draft.username}`, 'ok')
      draft = { username: '', password: '', is_admin: false, is_editor: false }
      revision += 1
    } catch (error) {
      pushToast(error.message)
    }
  }

  async function toggle(user, field) {
    try {
      await unwrap(() =>
        updateUser({ path: { user_id: user.id }, body: { [field]: !user[field] } })
      )
      revision += 1
    } catch (error) {
      // The server refuses to let the last admin demote themselves.
      pushToast(error.message)
    }
  }

  async function remove(user) {
    if (!confirm(`Delete ${user.username} and every answer they recorded?`)) return
    try {
      await unwrap(() => deleteUser({ path: { user_id: user.id } }))
      revision += 1
      pushToast(`Deleted ${user.username}`, 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }

  /**
   * Strip someone's second factor after they have lost the device holding it.
   *
   * The whole of the recovery story for an ordinary user: there are no recovery
   * codes, by decision, so this is the only way back in. Confirmed first
   * because it is the one action here that removes a protection rather than
   * granting one, and it signs them out — which is deliberate, so it cannot be
   * done to somebody without them noticing.
   */
  async function clearSecondFactor(user) {
    const warning = `Remove the second factor from ${user.username}? They will be signed out.`
    if (!confirm(warning)) return
    try {
      await unwrap(() => clearUserTotp({ path: { user_id: user.id } }))
    } catch (error) {
      pushToast(error.message)
      return
    }
    revision += 1
    pushToast(`${user.username} can sign in with their password alone`, 'ok')
  }

  async function resetPassword(user) {
    const new_password = prompt(`New password for ${user.username}`)
    if (!new_password) return
    try {
      await unwrap(() =>
        resetUserPassword({ path: { user_id: user.id }, body: { new_password } })
      )
      pushToast(`Password reset for ${user.username}`, 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }
</script>

<section class="mx-auto w-full max-w-4xl px-5 py-8">
  <p class="meta">Who can sign in</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">People</h1>

  <AdminOffline does="Accounts belong to the server rather than to this device" />

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each users as user (user.id)}
        <li
          data-user={user.id}
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
            <button class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                           disabled:cursor-not-allowed disabled:opacity-40"
              disabled={offline}
              title={hint} onclick={() => toggle(user, 'is_admin')}>
              {user.is_admin ? 'Revoke people' : 'Grant people'}
            </button>
            <button class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                           disabled:cursor-not-allowed disabled:opacity-40"
              disabled={offline}
              title={hint} onclick={() => toggle(user, 'is_editor')}>
              {user.is_editor ? 'Revoke questions' : 'Grant questions'}
            </button>
            <button class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                           disabled:cursor-not-allowed disabled:opacity-40"
              disabled={offline}
              title={hint} onclick={() => resetPassword(user)}>Reset password</button>
            <button
              data-clear-totp={user.id}
              class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                     disabled:cursor-not-allowed disabled:opacity-40"
              disabled={offline}
              title={hint}
              onclick={() => clearSecondFactor(user)}>Clear second factor</button>
            {#if user.id !== me?.id}
              <button class="meta rounded-md border border-ember/40 px-3 py-2 text-ember
                             hover:border-ember disabled:cursor-not-allowed
                             disabled:opacity-40"
                disabled={offline}
                title={hint} onclick={() => remove(user)}>Delete</button>
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
      <button
        type="submit"
        disabled={offline}
        title={hint}
        class="mt-5 rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift
               disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add person
      </button>
    </form>
  {/if}
</section>
