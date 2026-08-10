<script>
  import { link, navigate, path } from './lib/router.js'
  import Questionnaire from './routes/Questionnaire.svelte'
  import Table from './routes/Table.svelte'
  import Stats from './routes/Stats.svelte'
  import Settings from './routes/Settings.svelte'
  import Catalogue from './routes/Catalogue.svelte'
  import Users from './routes/Users.svelte'
  import Login from './routes/Login.svelte'
  import Toasts from './lib/Toasts.svelte'
  import { clearTokens, signedIn, tryApi } from './lib/api.js'

  const ROUTES = {
    '/': Questionnaire,
    '/table': Table,
    '/stats': Stats,
    '/settings': Settings,
    '/questions': Catalogue,
    '/people': Users,
    '/login': Login,
  }

  const Page = $derived(ROUTES[$path] ?? Questionnaire)

  let menuOpen = $state(false)

  let me = $state(null)

  $effect(() => {
    if ($signedIn) tryApi('/me').then((user) => (me = user))
    else me = null
  })

  // The editor and admin entries are hidden without the matching flag; the API
  // enforces it regardless, this only keeps the menu honest.
  const NAV = $derived([
    ['/', 'Answer'],
    ['/table', 'Record'],
    ['/stats', 'Patterns'],
    ...(me?.is_editor ? [['/questions', 'Questions']] : []),
    ...(me?.is_admin ? [['/people', 'People']] : []),
    ['/settings', 'Settings'],
  ])

  /** End the session and return to the sign-in form. */
  function signOut() {
    clearTokens()
    navigate('/login')
    menuOpen = false
  }
</script>

{#if !$signedIn}
  <Login />
{:else}
  <div class="min-h-screen">
    <header class="border-b border-white/8">
      <nav class="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <a href="/" use:link class="flex items-baseline gap-2">
          <span class="numeral text-xl">HT</span>
          <span class="meta hidden sm:inline">Happiness tracker</span>
        </a>

        <div class="hidden items-center gap-1 md:flex">
          {#each NAV as [href, label] (href)}
            <a
              {href}
              use:link
              class="meta rounded-md px-3 py-2 transition
                     {$path === href ? 'bg-white/8 text-paper' : 'hover:text-paper'}"
            >
              {label}
            </a>
          {/each}
          <button class="meta rounded-md px-3 py-2 hover:text-paper" onclick={signOut}>
            Sign out
          </button>
        </div>

        <button
          class="rounded-md border border-white/15 p-2 md:hidden"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
      </nav>

      {#if menuOpen}
        <div class="flex flex-col border-t border-white/8 px-5 py-2 md:hidden">
          {#each NAV as [href, label] (href)}
            <a {href} use:link class="meta py-3" onclick={() => (menuOpen = false)}>
              {label}
            </a>
          {/each}
          <button class="meta py-3 text-left" onclick={signOut}>Sign out</button>
        </div>
      {/if}
    </header>

    <main>
      <Page />
    </main>
  </div>
{/if}

<Toasts />
