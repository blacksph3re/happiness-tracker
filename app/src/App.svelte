<script>
  // `path` is aliased because this file also draws an SVG `<path>`, and Svelte
  // reads a lowercase tag that matches something in scope as ambiguous.
  import { link, navigate, path as route } from './lib/router.js'
  import Landing from './routes/Landing.svelte'
  import Questionnaire from './routes/wellbeing/Questionnaire.svelte'
  import Table from './routes/wellbeing/Table.svelte'
  import Stats from './routes/wellbeing/Stats.svelte'
  import Catalogue from './routes/wellbeing/Catalogue.svelte'
  import Track from './routes/time/Track.svelte'
  import Record from './routes/time/Record.svelte'
  import Patterns from './routes/time/Patterns.svelte'
  import Projects from './routes/time/Projects.svelte'
  import Settings from './routes/Settings.svelte'
  import Users from './routes/Users.svelte'
  import Login from './routes/Login.svelte'
  import Toasts from './lib/Toasts.svelte'
  import { clearTokens, signedIn } from './lib/api.js'
  import { ensureMe, me, resetStore } from './lib/store.js'
  import { forgetDigest, watchForChanges } from './lib/revalidate.js'
  import SyncBadge from './lib/SyncBadge.svelte'
  import { watch } from './lib/sync.js'
  import { applyUpdate, updateReady, watchForUpdates } from './lib/updates.js'

  const ROUTES = {
    '/': Landing,
    '/answer': Questionnaire,
    '/table': Table,
    '/stats': Stats,
    '/questions': Catalogue,
    '/time': Track,
    '/time/record': Record,
    '/time/patterns': Patterns,
    '/time/projects': Projects,
    '/settings': Settings,
    '/people': Users,
    '/login': Login,
  }

  const Page = $derived(ROUTES[$route] ?? Landing)

  let menuOpen = $state(false)

  $effect(() => {
    if ($signedIn) {
      ensureMe()
    } else {
      resetStore()
      // The digest describes one account. Kept across a sign-out it would be
      // compared against the next person's, which reports either every
      // collection as changed or — worse — none of them.
      forgetDigest()
    }
  })

  // Started once, for the life of the tab: the queue drains on the events that
  // mean it might work now, which on a phone is chiefly "the app came back".
  $effect(() => {
    watch()
    watchForChanges()
    watchForUpdates()
  })

  /** Pages that belong to the account rather than to either half. */
  const ACCOUNT_PATHS = ['/', '/settings', '/people']

  // The two halves are separate places: inside one, the nav is only about that
  // one, and the logo is the way back to the chooser. That is also what makes
  // "Record" and "Patterns" unambiguous again — there is one of each in view.
  //
  // Settings and People sit in neither. Treating them as wellbeing meant
  // opening Settings from a running timer quietly moved you into the other
  // half; from here the way on is the chooser, whichever half you came from.
  const section = $derived(
    $route.startsWith('/time') ? 'time' : ACCOUNT_PATHS.includes($route) ? null : 'wellbeing'
  )

  // Questions is offered to everyone: a catalogue belongs to the account that
  // answers it, so shaping one is not administration. Only People is still
  // gated, and the API enforces that regardless — this keeps the menu honest.
  const NAV = $derived(
    section === 'time'
      ? [
          ['/time', 'Track'],
          ['/time/record', 'Record'],
          ['/time/patterns', 'Patterns'],
          ['/time/projects', 'Projects'],
        ]
      : section === 'wellbeing'
        ? [
            ['/answer', 'Answer'],
            ['/table', 'Record'],
            ['/stats', 'Patterns'],
            ['/questions', 'Questions'],
          ]
        : []
  )

  const ACCOUNT = $derived([
    ...($me?.is_admin ? [['/people', 'People']] : []),
    ['/settings', 'Settings'],
  ])

  const MENU = $derived([...NAV, ...ACCOUNT])

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
  <!-- The whole time half sits inside this class, which rebinds the accent
       colour variables. Every `bg-dusk` below it recolours itself; nothing
       needs a second set of class names. -->
  <div class="min-h-screen" class:section-time={section === 'time'}>
    <header class="border-b border-white/8">
      <nav class="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <a href="/" use:link class="flex items-baseline gap-2">
          <span class="numeral text-xl">DT</span>
          <SyncBadge />
          <!-- The label names the half you are in. On the landing page and in
               Settings you are in neither, and "Tracker" there was a word that
               only ever restated the mark beside it. -->
          {#if section}
            <span class="meta hidden sm:inline">
              {section === 'time' ? 'Time' : 'Wellbeing'}
            </span>
          {/if}
        </a>

        <div class="hidden items-center gap-1 md:flex">
          {#each MENU as [href, label] (href)}
            <a
              {href}
              use:link
              class="meta rounded-md px-3 py-2 transition
                     {$route === href ? 'bg-white/8 text-paper' : 'hover:text-paper'}"
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
          {#each MENU as [href, label] (href)}
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

    <!-- Offered, not taken. Applying it reloads the page, and this app is one
         people are part-way through a questionnaire in. -->
    {#if $updateReady}
      <div
        data-update-ready
        class="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-wrap items-center
               justify-between gap-3 rounded-xl border border-white/15 bg-ink-soft px-4
               py-3 shadow-xl"
      >
        <p class="text-sm">A newer version is ready.</p>
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
          onclick={applyUpdate}
        >
          Reload to update
        </button>
      </div>
    {/if}
  </div>
{/if}

<Toasts />
