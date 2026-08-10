<script>
  import { storeTokens } from '../lib/api.js'
  import { navigate } from '../lib/router.js'

  let username = $state('')
  let password = $state('')
  let error = $state('')
  let busy = $state(false)

  /**
   * Exchange the entered credentials for a token pair.
   *
   * @param {SubmitEvent} event The form submission.
   */
  async function submit(event) {
    event.preventDefault()
    busy = true
    error = ''
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    busy = false
    if (!response.ok) {
      error = 'That username and password do not match.'
      return
    }
    storeTokens(await response.json())
    navigate('/')
  }
</script>

<section class="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6">
  <p class="meta">Happiness tracker</p>
  <h1 class="mt-2 text-4xl font-bold tracking-tight">Sign in</h1>
  <p class="mt-2 text-haze">Ten taps, once a day.</p>

  <form class="mt-8 flex flex-col gap-4" onsubmit={submit}>
    <label class="flex flex-col gap-1.5">
      <span class="meta">Username</span>
      <input
        bind:value={username}
        autocomplete="username"
        class="rounded-lg border border-white/15 bg-ink-soft px-4 py-3 text-paper
               focus:border-dusk-lift focus:outline-none"
      />
    </label>
    <label class="flex flex-col gap-1.5">
      <span class="meta">Password</span>
      <input
        type="password"
        bind:value={password}
        autocomplete="current-password"
        class="rounded-lg border border-white/15 bg-ink-soft px-4 py-3 text-paper
               focus:border-dusk-lift focus:outline-none"
      />
    </label>
    {#if error}
      <p class="text-sm text-ember">{error}</p>
    {/if}
    <button
      type="submit"
      disabled={busy}
      class="mt-2 rounded-lg bg-dusk px-5 py-3 font-semibold text-paper
             transition hover:bg-dusk-lift disabled:opacity-50"
    >
      {busy ? 'Signing in…' : 'Sign in'}
    </button>
  </form>
</section>
