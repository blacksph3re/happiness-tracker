<script>
  // `path` is aliased because this file also draws an SVG `<path>`, and Svelte
  // reads a lowercase tag that matches something in scope as ambiguous.
  import { link, mayNavigate, navigate, path as route } from './lib/router.js'
  import Landing from './routes/Landing.svelte'
  import Questionnaire from './routes/wellbeing/Questionnaire.svelte'
  import Table from './routes/wellbeing/Table.svelte'
  import Stats from './routes/wellbeing/Stats.svelte'
  import Catalogue from './routes/wellbeing/Catalogue.svelte'
  import Track from './routes/time/Track.svelte'
  import Record from './routes/time/Record.svelte'
  import Patterns from './routes/time/Patterns.svelte'
  import Projects from './routes/time/Projects.svelte'
  import Focus from './routes/pomodoro/Focus.svelte'
  import Tasks from './routes/todos/Tasks.svelte'
  import TodoCalendar from './routes/todos/Calendar.svelte'
  import TodoLists from './routes/todos/Lists.svelte'
  import FocusStats from './routes/pomodoro/Stats.svelte'
  import Settings from './routes/Settings.svelte'
  import Users from './routes/Users.svelte'
  import Login from './routes/Login.svelte'
  import Toasts from './lib/Toasts.svelte'
  import { clearTokens, signedIn } from './lib/api.js'
  import { ensureMe, me, resetStore } from './lib/store.js'
  import { forgetDigest, watchForChanges } from './lib/revalidate.js'
  import SyncBadge from './lib/SyncBadge.svelte'
  import { flush, hasPending, loadQueue, pending, settle, watch } from './lib/sync.js'
  import { watchTitle } from './lib/pomodoro/title.js'
  import { purgePush, refreshSubscription } from './lib/push.js'
  import { applyUpdate, updateReady, watchForUpdates } from './lib/updates.js'
  import { dismissOn } from './lib/dismiss.svelte.js'
  import Frame from './lib/Frame.svelte'
  import { clearToasts } from './lib/toasts.js'
  import { tick } from 'svelte'
  import { get } from 'svelte/store'

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
    '/focus': Focus,
    '/focus/patterns': FocusStats,
    '/todos': Tasks,
    '/todos/calendar': TodoCalendar,
    '/todos/lists': TodoLists,
    '/settings': Settings,
    '/people': Users,
    '/login': Login,
  }

  /**
   * Whether the address names a page at all.
   *
   * An unknown one used to draw the landing page under the Wellbeing menu while
   * keeping the address, so `/TIME` looked like a working link to the wrong
   * place. It gets a short page saying so instead, and keeps the address — the
   * typo is the thing somebody needs to see, and a silent replace with `/`
   * would hide it. `hasOwn`, because `'toString' in ROUTES` is true.
   */
  const known = $derived(Object.hasOwn(ROUTES, $route))

  const Page = $derived(known ? ROUTES[$route] : null)

  let menuOpen = $state(false)

  /** The button that opens the phone menu, where Escape hands focus back. */
  let menuButton = $state(null)

  /**
   * Close the phone menu on Escape, as every other overlay here closes.
   *
   * Focus always goes back to the Menu button. It used to only when focus was
   * inside the menu, which left a reader who had tabbed past the last row with
   * the menu gone and focus somewhere in the page under where it had been. An
   * Escape pressed while the menu is open is an Escape for the menu.
   */
  function closeMenuOnEscape(event) {
    if (event.key !== 'Escape') return
    if (asking) {
      cancelSignOut()
      return
    }
    if (!menuOpen) return
    menuOpen = false
    menuButton?.focus()
  }

  // A tap anywhere but the menu or its own button puts it away. Not on scroll:
  // the menu is positioned against the header rather than the viewport, so it
  // scrolls with the page instead of riding over it. Escape keeps its own
  // handler above, because it also hands focus back.
  dismissOn({
    within: '[data-phone-menu], [data-menu-toggle]',
    active: () => menuOpen,
    dismiss: (why) => {
      if (why === 'pointer') menuOpen = false
    },
  })

  $effect(() => {
    // The queue is read per account, so it is re-read whenever the account
    // changes without a reload: signed out, nothing of anybody's is waiting;
    // signed in, that account's own writes are, and signing in is what sends
    // them. Without it the badge and the projection kept the previous
    // account's queue until something happened to re-read it.
    loadQueue().then(() => {
      if (get(signedIn)) flush()
    })
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
    // Silent, and a no-op unless this browser is already enrolled: it asks for
    // nothing and shows nothing. What it buys is the timestamp saying the
    // device still exists, since a push service cannot be relied on to report
    // one as gone.
    refreshSubscription()
    // Returned so the countdown stops with the tab rather than outliving it.
    return watchTitle()
  })

  /** Pages that belong to the account rather than to any of the three halves. */
  const ACCOUNT_PATHS = ['/', '/settings', '/people', '/login']

  /** What each half is called beside the mark. */
  const SECTION_AREAS = { time: 'Time', focus: 'Focus', todos: 'Todos', wellbeing: 'Wellbeing' }

  /** What each account page is called beside the mark; `/` is the chooser. */
  const ACCOUNT_AREAS = { '/settings': 'Settings', '/people': 'People' }

  /**
   * What to call where you are, beside the mark.
   *
   * Separate from `section`, which decides the accent colours and the nav.
   * Settings and People are in no section — they take no accent and offer no
   * section nav — but they are still somewhere, and saying nothing there left
   * the header looking like the landing page while showing a form. Each says
   * its own name: People used to read "Settings". The landing page is the one
   * place with no answer, because it is the chooser, and an unknown address
   * is nowhere.
   */
  const area = $derived(section ? SECTION_AREAS[section] : (ACCOUNT_AREAS[$route] ?? null))

  // The two halves are separate places: inside one, the nav is only about that
  // one, and the logo is the way back to the chooser. That is also what makes
  // "Record" and "Patterns" unambiguous again — there is one of each in view.
  //
  // Settings and People sit in neither. Treating them as wellbeing meant
  // opening Settings from a running timer quietly moved you into the other
  // half; from here the way on is the chooser, whichever half you came from.
  const section = $derived(
    !known
      ? null
      : $route.startsWith('/time')
        ? 'time'
        : $route.startsWith('/focus')
          ? 'focus'
          : $route.startsWith('/todos')
            ? 'todos'
            : ACCOUNT_PATHS.includes($route)
              ? null
              : 'wellbeing'
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
      : section === 'focus'
        ? [
            ['/focus', 'Timer'],
            ['/focus/patterns', 'Patterns'],
          ]
        : section === 'todos'
          ? [
              ['/todos', 'Tasks'],
              ['/todos/calendar', 'Calendar'],
              ['/todos/lists', 'Lists'],
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

  /**
   * How long a sign-out waits for waiting writes to reach the server.
   *
   * Bounded, because a connection that neither answers nor fails would
   * otherwise hold the press for as long as the browser cares to wait, and the
   * question below is a better place to be than a button that did nothing.
   */
  const SEND_BEFORE_LEAVING = 5000

  /** How many changes were still waiting when a sign-out stopped to ask, or 0. */
  let asking = $state(0)

  /** Whether a sign-out is sending what is waiting before it goes. */
  let sending = $state(false)

  let cancelButton = $state(null)

  let signOutButton = $state(null)

  /**
   * The question a sign-out asks when writes could not be sent, as one string.
   *
   * What it says is what the code does. The outbox is never cleared: every
   * intent carries the account that made it, `loadQueue` and `drain` read only
   * the signed-in account's, so another account signing in here neither sees
   * nor sends them, and they go the next time their own account signs in on
   * this device. Only clearing the browser's storage loses them.
   */
  const askText = $derived(
    `${asking} ${asking === 1 ? 'change has' : 'changes have'} not reached the server. ` +
      `Sign out anyway? They stay on this device and are sent the next time ` +
      `${$me?.username ?? 'this account'} signs in here.`
  )

  /**
   * End the session, first sending anything this device is holding.
   *
   * With nothing waiting it is one press, as it always was. With writes
   * waiting it tries to send them, and only if they are still waiting after
   * that — offline, refused, or too slow — does it stop and ask.
   */
  async function signOut() {
    menuOpen = false
    if (hasPending()) {
      sending = true
      await Promise.race([
        settle(),
        new Promise((done) => setTimeout(done, SEND_BEFORE_LEAVING)),
      ])
      sending = false
      if (hasPending()) {
        asking = get(pending)
        await tick()
        cancelButton?.focus()
        return
      }
    }
    await leave()
  }

  /** Put the question away and give focus back to what asked it. */
  function cancelSignOut() {
    asking = 0
    const shown = signOutButton?.offsetParent ? signOutButton : menuButton
    shown?.focus()
  }

  /**
   * Return to the sign-in form.
   *
   * The push subscription goes first, while there is still a token to tell the
   * server with. Signing out means "stop telling me about pomodoros", and a
   * subscription does not expire with a token — left alone, the browser would
   * go on being notified by an account nobody is signed in to.
   *
   * Toasts go with the session: one about the account just left, still showing
   * over the sign-in form, reads as being about the next attempt.
   */
  async function leave() {
    asking = 0
    if (!mayNavigate('/login')) return
    clearToasts()
    await purgePush()
    clearTokens()
    navigate('/login')
  }

  /**
   * Move focus to the page, past the header.
   *
   * The link's own `#main` would do it too, but it also writes the fragment
   * into the address, which is a history entry for nothing.
   *
   * `main` is made focusable only for this and gives it up on blur. Left with a
   * standing `tabindex="-1"`, every press on empty space in a page focused it,
   * and focusing scrolls: a block carried across the calendar landed half an
   * hour from where it was aimed.
   */
  function skipToContent(event) {
    event.preventDefault()
    const main = document.getElementById('main')
    if (!main) return
    main.setAttribute('tabindex', '-1')
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true })
    main.focus()
  }
</script>

{#if !$signedIn}
  <Login />
{:else}
  <!-- The whole time half sits inside this class, which rebinds the accent
       colour variables. Every `bg-dusk` below it recolours itself; nothing
       needs a second set of class names. -->
  <div
    class="min-h-screen"
    class:section-time={section === 'time'}
    class:section-focus={section === 'focus'}
    class:section-todo={section === 'todos'}
  >
    <!-- The first tab stop on every page. Parked above the top edge and brought
         down while it has focus, rather than `sr-only`: that and `fixed` are
         both position utilities, and which one wins is the stylesheet's order
         rather than anything written here. -->
    <a
      href="#main"
      class="fixed top-2 left-2 z-[60] -translate-y-[200%] rounded-md border border-white/15 bg-ink-soft
             px-4 py-2 text-sm text-paper shadow-xl focus:translate-y-0"
      onclick={skipToContent}
    >
      Skip to content
    </a>
    <header class="relative border-b border-white/8">
      <!-- The frame's cap and gutter (`lib/Frame.svelte`), so the logo and every
           page heading share one left edge. `box-content` puts the gutter
           outside the cap, as the frame's own padding sits outside its cap. -->
      <nav
        class="mx-auto box-content flex max-w-frame items-center justify-between gap-4 px-(--gutter) py-4"
      >
        <!-- The badge sits *beside* the link, not inside it. Nested, its only
             way to stay put was to swallow the parent's navigation, which made
             it a span with a click handler and left one stray event away from
             sending you to the landing page. Out here it is an ordinary
             button. -->
        <span class="flex items-baseline gap-2">
          <!-- A 44px target around a 28px mark, from a negative margin and the
               padding it gives back, so the drawn header does not move. The
               reach is 12px to the left, which is the gutter, and 4px to the
               right, which meets the badge's own 4px in the 8px gap between
               them rather than overlapping it. -->
          <a
            href="/"
            use:link
            class="-my-2 -mr-1 -ml-3 flex min-h-11 min-w-11 items-baseline gap-2 py-2 pr-1 pl-3"
          >
            <span class="numeral text-xl">DT</span>
          </a>
          <SyncBadge />
          <!-- The label names where you are. The landing page is the one place
               with no answer, because it is the chooser. -->
          {#if area}
            <span class="meta hidden sm:inline" data-area>{area}</span>
          {/if}
        </span>

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
          <button
            bind:this={signOutButton}
            class="meta rounded-md px-3 py-2 hover:text-paper"
            aria-expanded={asking > 0}
            disabled={sending}
            onclick={signOut}
          >
            {sending ? 'Sending…' : 'Sign out'}
          </button>
        </div>

        <!-- The drawn box is the inner span, 38px; the button around it reaches
             44px through a negative margin, so the outline stays where it was. -->
        <button
          bind:this={menuButton}
          class="-m-[3px] flex size-11 items-center justify-center md:hidden"
          aria-label="Menu"
          aria-expanded={menuOpen}
          data-menu-toggle
          onclick={() => (menuOpen = !menuOpen)}
        >
          <span class="rounded-md border border-white/15 p-2">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </span>
        </button>
      </nav>

      {#if menuOpen}
        <!-- Over the page, not in it: opened in place it pushed every page down
             260px, and closing it moved everything back. Hung from the foot of
             the header, the page's own width, with 44px rows — a `py-3` row of
             `.meta` text measured 41. -->
        <div
          class="absolute inset-x-0 top-full z-40 flex flex-col border-y border-white/8 bg-ink
                 px-(--gutter) py-2 shadow-xl md:hidden"
          data-phone-menu
        >
          {#each MENU as [href, label] (href)}
            <a {href} use:link class="meta flex min-h-11 items-center" onclick={() => (menuOpen = false)}>
              {label}
            </a>
          {/each}
          <button class="meta flex min-h-11 items-center text-left" onclick={signOut}>Sign out</button>
        </div>
      {/if}

      {#if asking}
        <!-- Hung from the header like the menu, so asking moves nothing on the
             page. The sentence is one string, so no clause loses its space. -->
        <div
          class="absolute inset-x-0 top-full z-40 border-y border-white/8 bg-ink px-(--gutter) py-3
                 shadow-xl"
          role="alertdialog"
          aria-labelledby="signout-ask"
          data-signout-confirm
        >
          <div class="mx-auto flex max-w-frame flex-wrap items-center justify-end gap-2">
            <span id="signout-ask" class="flex-1 basis-full text-sm text-haze sm:basis-auto" data-signout-ask>
              {askText}
            </span>
            <span class="flex items-center gap-2">
              <button
                class="btn-danger meta border-alarm text-paper transition hover:bg-alarm/10"
                onclick={leave}
              >
                Sign out anyway
              </button>
              <button bind:this={cancelButton} class="btn-outline meta" onclick={cancelSignOut}>
                Cancel
              </button>
            </span>
          </div>
        </div>
      {/if}
    </header>

    <main id="main" class="outline-none">
      {#if Page}
        <Page />
      {:else}
        <Frame>
          <section class="py-8" data-not-found>
            <p class="meta">Not found</p>
            <h1 class="mt-1 text-3xl font-bold tracking-tight">Nothing lives at this address</h1>
            <p class="mt-2 break-words text-haze">{`${$route} is not a page here.`}</p>
            <a href="/" use:link class="btn-outline meta mt-6 inline-flex">Back to the start</a>
          </section>
        </Frame>
      {/if}
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
          class="btn-outline meta"
          onclick={applyUpdate}
        >
          Reload to update
        </button>
      </div>
    {/if}
  </div>
{/if}

<svelte:window onkeydown={closeMenuOnEscape} />

<Toasts />
