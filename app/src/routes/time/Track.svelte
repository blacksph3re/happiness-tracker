<script>
  import ProjectCard from '../../lib/time/ProjectCard.svelte'
  import { attempt } from '../../lib/api.js'
  import {
    createProject,
  } from '../../lib/generated/sdk.gen'
  import {
    elapsed,
    formatShort,
    localDay,
    nowUtc,
    utcOffset,
  } from '../../lib/time/duration.js'
  import { today } from '../../lib/day.js'
  import { nextColour } from '../../lib/time/palette.js'
  import { now } from '../../lib/time/tick.js'
  import {
    ensureProjects,
    ensureTimeEntries,
    projects as projectStore,
    saveEntry,
    timeEntries,
  } from '../../lib/store.js'
  import { link, query } from '../../lib/router.js'
  import { pushToast } from '../../lib/toasts.js'

  let loading = $state(true)
  let newName = $state('')
  // Per project, not one lock for the page. A single flag disabled every other
  // card for the length of the request, which flashed them all on a tap that
  // had nothing to do with them - and it swallowed a quick second check-in,
  // which is exactly the thing this view is built to allow.
  let busy = $state([])

  const active = $derived(($projectStore ?? []).filter((project) => project.active))

  /**
   * The project a link asked for, so arriving from the record lands on it.
   *
   * A `?project=` in the URL rather than a store, so the page can be reloaded
   * or shared and still be about the same thing. It only marks the card; it
   * never starts anything, because arriving somewhere is not consent to record.
   */
  const focus = $derived(Number($query.get('project')) || null)

  // Scrolled to, for an account with more projects than fit a screen: the ring
  // is no use below the fold.
  $effect(() => {
    if (!focus) return
    document
      .querySelector(`[data-project="${focus}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })

  /** The open session per project, so several timers can run at once. */
  const runningByProject = $derived(
    new Map(
      $timeEntries.filter((entry) => entry.ended_at === null).map((e) => [e.project_id, e])
    )
  )

  /**
   * The projects whose last session can be taken back.
   *
   * Only while the project is idle and that session ended today: resuming
   * absorbs everything since it stopped, and absorbing a week is not a mistake
   * anyone means to make.
   */
  const resumableProjects = $derived.by(() => {
    const latest = new Map()
    for (const entry of $timeEntries) {
      if (entry.ended_at === null) continue
      const held = latest.get(entry.project_id)
      if (!held || entry.ended_at > held.ended_at) latest.set(entry.project_id, entry)
    }
    return new Map(
      [...latest.entries()].filter(
        ([id, entry]) => !runningByProject.has(id) && endedToday(entry)
      )
    )
  })

  /** Whether a session finished on the local day now in progress. */
  function endedToday(entry) {
    return localDay(entry.ended_at, entry.utc_offset) === today()
  }

  const anyRunning = $derived(
    active
      .map((project) => runningByProject.get(project.id))
      .filter(Boolean)
      .map((entry) => ({
        entry,
        project: active.find((p) => p.id === entry.project_id),
        seconds: elapsed(entry, $now),
      }))
  )

  $effect(() => {
    load()
  })

  // The tab carries the longest-running timer, so a forgotten one is noticed
  // from any other tab rather than after three accidental hours. Restored on
  // teardown, or every other page inherits a stale timer in its title.
  $effect(() => {
    const original = 'Daily Tracker'
    const leader = anyRunning.toSorted((a, b) => b.seconds - a.seconds)[0]
    document.title = leader
      ? `▶ ${formatShort(leader.seconds)} · ${leader.project.name}`
      : original
    return () => {
      document.title = original
    }
  })

  async function load() {
    try {
      await Promise.all([
        ensureProjects(),
        // Only today matters here; an open session from further back still
        // arrives, because the range never drops one that is still running.
        ensureTimeEntries({ start: today(), end: today() }),
      ])
    } finally {
      loading = false
    }
  }

  /**
   * Start or stop one project, leaving every other timer alone.
   *
   * Both are the same write — a session under the device's own identity, with
   * or without an end — and both are queued rather than sent. Checking in with
   * no signal is the case this whole design exists for: the timer starts now,
   * and the server hears about it when there is one.
   */
  async function toggle(project, running) {
    if (busy.includes(project.id)) return
    busy = [...busy, project.id]
    try {
      if (running) {
        await saveEntry({
          client_id: running.client_id,
          project_id: project.id,
          started_at: running.started_at,
          ended_at: nowUtc(),
          utc_offset: running.utc_offset,
          note: running.note ?? null,
        })
      } else {
        await saveEntry({
          project_id: project.id,
          started_at: nowUtc(),
          ended_at: null,
          utc_offset: utcOffset(),
        })
      }
    } finally {
      busy = busy.filter((id) => id !== project.id)
    }
  }

  /** Take back a stop: the old session reopens and swallows the gap. */
  async function resume(project) {
    if (busy.includes(project.id)) return
    const last = resumableProjects.get(project.id)
    if (!last) return
    busy = [...busy, project.id]
    try {
      // Reopening is the session written again with no end: the original start
      // is kept, so the pause since it stopped counts as worked — which is what
      // taking back a stop means, and is why this is not a fresh check-in.
      await saveEntry({
        client_id: last.client_id,
        project_id: project.id,
        started_at: last.started_at,
        ended_at: null,
        utc_offset: last.utc_offset,
        note: last.note ?? null,
      })
    } finally {
      busy = busy.filter((id) => id !== project.id)
    }
  }

  async function addProject() {
    const name = newName.trim()
    if (!name) return
    const created = await attempt(() =>
      createProject({ body: { name, colour: nextColour(($projectStore ?? []).length) } })
    )
    if (!created) return
    newName = ''
    await ensureProjects({ force: true })
    pushToast(`Tracking ${created.name}`, 'ok')
  }
</script>

<section class="mx-auto w-full max-w-3xl px-5 py-8">
  <p class="meta">What the hours went to</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">Track</h1>

  {#if loading}
    <p class="meta">Loading your projects…</p>
  {:else if active.length === 0}
    <!-- A new account owns no projects, so the first one is created here rather
         than behind a link to somewhere else. -->
    <div class="rounded-xl border border-white/10 bg-ink-soft p-6">
      <h2 class="font-semibold">Nothing to track yet</h2>
      <p class="mt-1 mb-4 text-sm text-haze">
        Name one and it becomes a button you tap to start.
      </p>
      <form class="flex flex-wrap gap-2" onsubmit={(e) => (e.preventDefault(), addProject())}>
        <input
          bind:value={newName}
          placeholder="The rewrite"
          aria-label="Project name"
          class="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink px-4 py-3"
        />
        <button
          type="submit"
          disabled={!newName.trim()}
          class="rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift
                 disabled:cursor-not-allowed disabled:opacity-30"
        >
          Add project
        </button>
      </form>
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each active as project (project.id)}
        {@const running = runningByProject.get(project.id) ?? null}
        <ProjectCard
          {project}
          {running}
          seconds={running ? elapsed(running, $now) : 0}
          resumable={resumableProjects.get(project.id) ?? null}
          disabled={busy.includes(project.id)}
          focused={project.id === focus}
          ontoggle={toggle}
          onresume={resume}
        />
      {/each}
    </div>

    <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
      <form
        class="flex min-w-0 flex-1 basis-56 gap-2"
        onsubmit={(e) => (e.preventDefault(), addProject())}
      >
        <input
          bind:value={newName}
          placeholder="Another project"
          aria-label="Project name"
          class="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink-soft px-4 py-2.5 text-sm"
        />
        <button
          type="submit"
          disabled={!newName.trim()}
          class="meta rounded-md border border-white/15 px-4 py-2.5 hover:border-white/40
                 disabled:cursor-not-allowed disabled:opacity-30"
        >
          Add
        </button>
      </form>
      <a
        href="/time/projects"
        use:link
        class="meta rounded-md border border-white/15 px-4 py-2.5 hover:border-white/40"
      >
        Manage projects →
      </a>
    </div>

    {#if anyRunning.length > 1}
      <p class="meta mt-4 normal-case">
        {anyRunning.length} timers running, counted separately.
      </p>
    {/if}
  {/if}
</section>
