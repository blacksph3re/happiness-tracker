<script>
  import { storeTokens, unwrap } from '../lib/api.js'
  import { login as loginCall, loginTotp } from '../lib/generated/sdk.gen'
  import { navigate } from '../lib/router.js'

  /**
   * Signing in, in one step or two.
   *
   * The second step is a different form rather than a field that appears
   * underneath the first: the password is already spent by then, and leaving it
   * on screen invites re-submitting it against an endpoint that no longer wants
   * it.
   */

  let username = $state('')
  let password = $state('')
  let code = $state('')
  let error = $state('')
  let busy = $state(false)

  /**
   * The token authorising the second step, held only in memory.
   *
   * Not in localStorage: it is worthless after five minutes and worth something
   * for those five, so it should not outlive the attempt it belongs to.
   */
  let challenge = $state('')

  /** What a failure means, in the words the person on the form needs. */
  function explain(failure, fallback) {
    // A lockout has to say so. Told "that is wrong" instead, someone who typed
    // the right thing just keeps trying and stays locked out.
    return failure?.status === 429 ? failure.message : fallback
  }

  async function submit(event) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      const result = await unwrap(() =>
        loginCall({ body: { username, password }, auth: false })
      )
      if (result.status === 'totp_required') {
        challenge = result.totp_token
        // The password has done its work; there is no reason to keep holding it.
        password = ''
        return
      }
      storeTokens(result)
    } catch (failure) {
      error = explain(failure, 'That username and password do not match.')
      return
    } finally {
      busy = false
    }
    navigate('/')
  }

  async function answer(event) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      storeTokens(
        await unwrap(() =>
          loginTotp({ body: { totp_token: challenge, code }, auth: false })
        )
      )
    } catch (failure) {
      code = ''
      // A challenge that has expired cannot be answered again, and saying so on
      // the code field would send someone hunting for a fault in their phone.
      if (failure?.status === 429) {
        error = failure.message
      } else {
        error = 'That code did not work. Each one can be used once.'
      }
      return
    } finally {
      busy = false
    }
    navigate('/')
  }

  /** Abandon the challenge and start again, for a wrong account or a lost phone. */
  function startOver() {
    challenge = ''
    code = ''
    error = ''
  }
</script>

<section class="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6">
  <p class="meta">Daily tracker</p>

  {#if challenge}
    <h1 class="mt-2 text-4xl font-bold tracking-tight">One more thing</h1>
    <p class="mt-2 text-haze">The six digits from your authenticator.</p>

    <form class="mt-8 flex flex-col gap-4" onsubmit={answer}>
      <label class="flex flex-col gap-1.5">
        <span class="meta">Code</span>
        <!-- `one-time-code` is what lets a phone offer the code from the
             notification, and the numeric mode is what stops it opening a
             keyboard nobody needs here. -->
        <input
          bind:value={code}
          data-totp-code
          inputmode="numeric"
          autocomplete="one-time-code"
          autofocus
          maxlength="8"
          class="numeral rounded-lg border border-white/15 bg-ink-soft px-4 py-3
                 text-2xl tracking-[0.4em] text-paper focus:border-dusk-lift
                 focus:outline-none"
        />
      </label>
      {#if error}
        <p class="text-sm text-ember">{error}</p>
      {/if}
      <button
        type="submit"
        disabled={busy || !code.trim()}
        class="mt-2 rounded-lg bg-dusk px-5 py-3 font-semibold text-paper
               transition hover:bg-dusk-lift disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <button
        type="button"
        onclick={startOver}
        class="meta self-center underline underline-offset-4 hover:text-paper"
      >
        Start again
      </button>
    </form>
  {:else}
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
  {/if}
</section>
