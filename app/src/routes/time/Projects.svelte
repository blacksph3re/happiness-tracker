<script>
  import { attempt, unwrap } from '../../lib/api.js'
  import {
    createProject,
    createTag,
    deleteProject,
    deleteTag,
    listDeductions,
    setDeductions,
    updateProject,
    updateTag,
  } from '../../lib/generated/sdk.gen'
  import {
    ensureProjects,
    ensureTags,
    ensureTimeEntries,
    forgetSummaries,
    projects as projectStore,
    tags as tagStore,
  } from '../../lib/store.js'
  import { deductionFor, previewPoints } from '../../lib/time/deductions.js'
  import { formatDuration } from '../../lib/time/duration.js'
  import { nextColour, PROJECT_COLOURS as COLOURS } from '../../lib/time/palette.js'
  import { pushToast } from '../../lib/toasts.js'

  /**
   * Everything about a project except starting it: order, colour, archiving,
   * and the tags it is grouped under. Tags are managed on the same page, so the
   * tag-a-project loop never leaves it.
   */

  let loading = $state(true)
  let newProject = $state('')
  let newTag = $state('')
  let editing = $state(null)
  let editingBands = $state(null)
  let bands = $state([])

  const projects = $derived($projectStore ?? [])
  const tags = $derived($tagStore ?? [])

  $effect(() => {
    load()
  })

  async function load() {
    try {
      await Promise.all([ensureProjects(), ensureTags()])
    } finally {
      loading = false
    }
  }

  async function refresh() {
    await Promise.all([
      ensureProjects({ force: true }),
      ensureTags({ force: true }),
      // A project's colour or name shows on every session, so the record and
      // patterns pages are stale until their entries are read back.
      ensureTimeEntries({ force: true }),
    ])
  }

  async function addProject() {
    const name = newProject.trim()
    if (!name) return
    const created = await attempt(() =>
      createProject({ body: { name, colour: nextColour(projects.length) } })
    )
    if (!created) return
    newProject = ''
    await refresh()
  }

  async function addTag() {
    const name = newTag.trim()
    if (!name) return
    const created = await attempt(() =>
      createTag({ body: { name, colour: nextColour(tags.length) } })
    )
    if (!created) return
    newTag = ''
    await refresh()
  }

  async function saveProject(project, body) {
    const saved = await attempt(() =>
      updateProject({ path: { project_id: project.id }, body })
    )
    if (!saved) return
    await refresh()
  }

  async function removeProject(project) {
    // A 204 unwraps to null, which is also a failure, so this reads the throw.
    try {
      await unwrap(() => deleteProject({ path: { project_id: project.id } }))
    } catch (error) {
      pushToast(error.message)
      return
    }
    await refresh()
    pushToast(`Removed ${project.name}`, 'ok')
  }

  async function removeTag(tag) {
    try {
      await unwrap(() => deleteTag({ path: { tag_id: tag.id } }))
    } catch (error) {
      pushToast(error.message)
      return
    }
    await refresh()
    pushToast(`Removed ${tag.name}`, 'ok')
  }

  /**
   * Open a tag's deduction rule for editing.
   *
   * Loaded on demand: most tags have no rule, and the summary already carries
   * the numbers it produces, so the bands themselves are only wanted here.
   */
  async function openBands(tag) {
    editingBands = tag.id
    bands = (await attempt(() => listDeductions({ path: { tag_id: tag.id } }))) ?? []
  }

  async function saveBands(tag) {
    const body = bands
      .map((band) => ({
        from_minutes: Number(band.from_minutes) || 0,
        // null is not "zero minutes" but "as much as it takes": a cap.
        deduct_minutes:
          band.deduct_minutes === null ? null : Number(band.deduct_minutes) || 0,
      }))
      .sort((a, b) => a.from_minutes - b.from_minutes)
    const saved = await attempt(() => setDeductions({ path: { tag_id: tag.id }, body }))
    if (!saved) return
    // The rule changes what every day of this tag reports, including the ones
    // already on screen elsewhere.
    forgetSummaries()
    editingBands = null
    pushToast(`Saved the rule for ${tag.name}`, 'ok')
  }

  /** Add or remove one tag from a project, keeping the rest. */
  function toggleTag(project, tag) {
    const current = project.tags.map((t) => t.id)
    const next = current.includes(tag.id)
      ? current.filter((id) => id !== tag.id)
      : [...current, tag.id]
    saveProject(project, { tag_ids: next })
  }

  // Positions can be sparse after edits, so a move rewrites the run as 0..n-1
  // rather than trusting the numbers already there.
  async function move(project, delta) {
    const ordered = [...projects]
    const from = ordered.findIndex((p) => p.id === project.id)
    const to = from + delta
    if (to < 0 || to >= ordered.length) return
    ordered.splice(to, 0, ordered.splice(from, 1)[0])
    for (const [position, item] of ordered.entries()) {
      if (item.position !== position) {
        await attempt(() =>
          updateProject({ path: { project_id: item.id }, body: { position } })
        )
      }
    }
    await refresh()
  }
</script>

<section class="mx-auto w-full max-w-4xl px-5 py-8">
  <p class="meta">What you track, and how it groups</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">Projects</h1>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each projects as project, position (project.id)}
        <li
          data-project-row={project.id}
          class="rounded-lg border border-white/10 bg-ink-soft px-5 py-4
                 {project.active ? '' : 'opacity-50'}"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-3">
              <span
                class="size-3 shrink-0 rounded-full"
                style:background="var(--color-{project.colour}, var(--color-dusk-lift))"
              ></span>
              <div class="min-w-0">
                <p class="truncate font-medium">{project.name}</p>
                <p class="meta mt-1 normal-case">
                  {project.tags.length
                    ? project.tags.map((tag) => tag.name).join(' · ')
                    : 'Untagged'}
                </p>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="flex items-center gap-1">
                <button
                  class="meta rounded-md border border-white/15 px-2 py-2 hover:border-white/40
                         disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label="Move {project.name} earlier"
                  disabled={position === 0}
                  onclick={() => move(project, -1)}
                >
                  ↑
                </button>
                <button
                  class="meta rounded-md border border-white/15 px-2 py-2 hover:border-white/40
                         disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label="Move {project.name} later"
                  disabled={position === projects.length - 1}
                  onclick={() => move(project, 1)}
                >
                  ↓
                </button>
              </span>
              <button
                class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
                onclick={() => (editing = editing === project.id ? null : project.id)}
              >
                Edit
              </button>
              <button
                class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
                onclick={() => saveProject(project, { active: !project.active })}
              >
                {project.active ? 'Archive' : 'Restore'}
              </button>
            </div>
          </div>

          {#if editing === project.id}
            <div class="mt-4 flex flex-col gap-4 border-t border-white/10 pt-4">
              <label class="flex flex-col gap-1.5">
                <span class="meta">Name</span>
                <input
                  value={project.name}
                  maxlength="80"
                  class="rounded-lg border border-white/15 bg-ink px-4 py-2.5"
                  onchange={(e) => saveProject(project, { name: e.currentTarget.value })}
                />
              </label>

              <div class="flex flex-col gap-1.5">
                <span class="meta">Colour</span>
                <div class="flex flex-wrap gap-2">
                  {#each COLOURS as colour (colour)}
                    <button
                      aria-label="Colour {colour}"
                      aria-pressed={project.colour === colour}
                      class="size-8 rounded-full border-2 transition
                             {project.colour === colour
                        ? 'border-paper'
                        : 'border-transparent hover:border-white/40'}"
                      style:background="var(--color-{colour})"
                      onclick={() => saveProject(project, { colour })}
                    ></button>
                  {/each}
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <span class="meta">Tags</span>
                {#if tags.length === 0}
                  <p class="text-sm text-haze">No tags yet — add one below.</p>
                {:else}
                  <div class="flex flex-wrap gap-2">
                    {#each tags as tag (tag.id)}
                      {@const on = project.tags.some((t) => t.id === tag.id)}
                      <button
                        aria-pressed={on}
                        class="meta rounded-md border px-3 py-2 transition
                               {on
                          ? 'border-ember bg-dusk/30 text-paper'
                          : 'border-white/15 hover:border-white/40'}"
                        onclick={() => toggleTag(project, tag)}
                      >
                        {tag.name}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>

              <button
                class="meta self-start rounded-md border border-white/15 px-3 py-2
                       hover:border-ember"
                onclick={() => removeProject(project)}
              >
                Delete project
              </button>
            </div>
          {/if}
        </li>
      {:else}
        <li class="rounded-lg border border-white/10 bg-ink-soft px-5 py-8 text-haze">
          No projects yet. Add the first one below.
        </li>
      {/each}
    </ul>

    <form
      class="mt-4 flex gap-2"
      onsubmit={(event) => (event.preventDefault(), addProject())}
    >
      <input
        bind:value={newProject}
        placeholder="New project"
        aria-label="New project"
        class="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink-soft px-4 py-2.5 text-sm"
      />
      <button
        type="submit"
        disabled={!newProject.trim()}
        class="meta rounded-md border border-white/15 px-4 py-2.5 hover:border-white/40
               disabled:cursor-not-allowed disabled:opacity-30"
      >
        Add
      </button>
    </form>

    <div class="mt-10">
      <h2 class="font-semibold">Tags</h2>
      <p class="mt-1 mb-3 text-sm text-haze">
        Groups projects on the patterns page. A project can carry several, and counts
        under each.
      </p>

      <ul class="flex flex-col gap-2">
        {#each tags as tag (tag.id)}
          {@const covered = projects.filter((p) => p.tags.some((t) => t.id === tag.id))}
          <li
            data-tag-row={tag.id}
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                   border-white/10 bg-ink-soft px-5 py-4"
          >
            <div class="flex min-w-0 items-center gap-3">
              <span
                class="size-3 shrink-0 rounded-full"
                style:background="var(--color-{tag.colour}, var(--color-dusk-lift))"
              ></span>
              <div class="min-w-0">
                <p class="truncate font-medium">{tag.name}</p>
                <p class="meta mt-1 normal-case">
                  {covered.length
                    ? covered.map((p) => p.name).join(' · ')
                    : 'Covers nothing yet'}
                </p>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              {#each COLOURS as colour (colour)}
                <button
                  aria-label="Colour {colour} for {tag.name}"
                  class="size-6 rounded-full border-2 transition
                         {tag.colour === colour
                    ? 'border-paper'
                    : 'border-transparent hover:border-white/40'}"
                  style:background="var(--color-{colour})"
                  onclick={async () => {
                    await attempt(() => updateTag({ path: { tag_id: tag.id }, body: { colour } }))
                    await refresh()
                  }}
                ></button>
              {/each}
              <button
                class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
                onclick={() => (editingBands === tag.id ? (editingBands = null) : openBands(tag))}
              >
                Rule
              </button>
              <button
                class="meta rounded-md border border-white/15 px-3 py-2 hover:border-ember"
                onclick={() => removeTag(tag)}
              >
                Remove
              </button>
            </div>

            {#if editingBands === tag.id}
              <div class="mt-4 w-full border-t border-white/10 pt-4" data-bands={tag.id}>
                <p class="meta normal-case">
                  Turns tracked time into reported time on this tag's days.
                </p>

                <div class="mt-3 flex flex-col gap-2">
                  {#each bands as band, index (index)}
                    <div class="flex flex-wrap items-end gap-3">
                      <label class="flex flex-col gap-1.5">
                        <span class="meta">From (minutes)</span>
                        <input
                          type="number"
                          min="0"
                          bind:value={band.from_minutes}
                          aria-label="Band {index + 1} threshold"
                          class="numeral w-28 rounded-lg border border-white/15 bg-ink px-3
                                 py-2 text-sm"
                        />
                      </label>
                      <label class="flex flex-col gap-1.5">
                        <span class="meta">Deduct (minutes)</span>
                        <input
                          type="number"
                          min="0"
                          disabled={band.deduct_minutes === null}
                          value={band.deduct_minutes ?? ''}
                          oninput={(event) =>
                            (band.deduct_minutes = Number(event.currentTarget.value))}
                          placeholder="the rest"
                          aria-label="Band {index + 1} deduction"
                          class="numeral w-28 rounded-lg border border-white/15 bg-ink px-3
                                 py-2 text-sm disabled:opacity-40"
                        />
                      </label>
                      <label class="flex items-center gap-2 py-2">
                        <input
                          type="checkbox"
                          checked={band.deduct_minutes === null}
                          onchange={(event) =>
                            (band.deduct_minutes = event.currentTarget.checked ? null : 30)}
                          aria-label="Band {index + 1} caps the day"
                          class="h-4 w-4 rounded border-white/25 bg-ink accent-ember"
                        />
                        <span class="meta">Cap here</span>
                      </label>
                      <button
                        class="meta rounded-md border border-white/15 px-3 py-2
                               hover:border-ember"
                        aria-label="Remove band {index + 1}"
                        onclick={() => (bands = bands.filter((_, at) => at !== index))}
                      >
                        ×
                      </button>
                    </div>
                  {:else}
                    <p class="text-sm text-haze">
                      No rule: this tag reports exactly what it tracked.
                    </p>
                  {/each}
                </div>

                {#if bands.length}
                  <!-- Shown rather than described: bands replace each other, so
                       two of ten minutes do not make twenty on a long day, and
                       a sentence saying so is easy to read past. -->
                  <div class="mt-4 rounded-lg border border-white/10 p-3">
                    <p class="meta">What this rule does</p>
                    <table class="mt-2 w-full">
                      <thead>
                        <tr class="text-left">
                          <th class="meta py-1">A day of</th>
                          <th class="meta py-1 text-right">Loses</th>
                          <th class="meta py-1 text-right">Reports</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each previewPoints(bands) as minutes (minutes)}
                          {@const lost = deductionFor(minutes, bands)}
                          <tr class="border-t border-white/5">
                            <td class="numeral py-1 tabular-nums">
                              {formatDuration(minutes * 60)}
                            </td>
                            <td class="numeral py-1 text-right tabular-nums
                                       {lost ? 'text-ember' : 'text-haze'}">
                              {formatDuration(lost * 60)}
                            </td>
                            <td class="numeral py-1 text-right tabular-nums">
                              {formatDuration((minutes - lost) * 60)}
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                    <p class="meta mt-2 normal-case">
                      Only the highest band a day reaches applies — they replace each
                      other rather than adding up. A day with nothing tracked loses
                      nothing. A capped band reports its threshold however long the day
                      ran.
                    </p>
                  </div>
                {/if}

                <div class="mt-3 flex flex-wrap gap-2">
                  <button
                    class="meta rounded-md border border-white/15 px-3 py-2
                           hover:border-white/40"
                    onclick={() =>
                      (bands = [...bands, { from_minutes: 0, deduct_minutes: 30 }])}
                  >
                    Add a band
                  </button>
                  <button
                    class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold
                           hover:bg-dusk-lift"
                    onclick={() => saveBands(tag)}
                  >
                    Save rule
                  </button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ul>

      <form class="mt-4 flex gap-2" onsubmit={(event) => (event.preventDefault(), addTag())}>
        <input
          bind:value={newTag}
          placeholder="New tag"
          aria-label="New tag"
          class="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink-soft px-4 py-2.5 text-sm"
        />
        <button
          type="submit"
          disabled={!newTag.trim()}
          class="meta rounded-md border border-white/15 px-4 py-2.5 hover:border-white/40
                 disabled:cursor-not-allowed disabled:opacity-30"
        >
          Add
        </button>
      </form>
    </div>
  {/if}
</section>
