<script>
  import ProjectCard from '../../lib/time/ProjectCard.svelte'
  import { attempt } from '../../lib/api.js'
  import { checkIn, checkOut, createProject } from '../../lib/generated/sdk.gen'
  import { elapsed, formatShort, nowUtc, utcOffset } from '../../lib/time/duration.js'
  import { today } from '../../lib/day.js'
  import { nextColour } from '../../lib/time/palette.js'
  import { now } from '../../lib/time/tick.js'
  import {
    ensureProjects,
    ensureTimeEntries,
    projects as projectStore,
    rememberEntry,
    timeEntries,
  } from '../../lib/store.js'
  import { link } from '../../lib/router.js'
  import { pushToast } from '../../lib/toasts.js'

  let loading = $state(true)
  let newName = $state('')
  let busy = $state(null)

  const active = $derived(($projectStore ?? []).filter((project) => project.active))

  /** The open session per project, so several timers can run at once. */
  const runningByProject = $derived(
    new Map(
      $timeEntries.filter((entry) => entry.ended_at === null).map((e) => [e.project_id, e])
    )
  )

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
    const original = 'Happiness tracker'
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

  /** Start or stop one project, leaving every other timer alone. */
  async function toggle(project, running) {
    if (busy) return
    busy = project.id
    try {
      if (running) {
        const closed = await attempt(() =>
          checkOut({ path: { project_id: project.id }, body: { at: nowUtc() } })
        )
        if (closed) rememberEntry(closed)
      } else {
        const opened = await attempt(() =>
          checkIn({
            path: { project_id: project.id },
            body: { at: nowUtc(), utc_offset: utcOffset() },
          })
        )
        if (opened) rememberEntry(opened)
      }
    } finally {
      busy = null
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
          disabled={busy !== null && busy !== project.id}
          ontoggle={toggle}
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
