<script>
  import { attempt, unwrap } from '../../lib/api.js'
  import {
    createProject,
    createTag,
    deleteProject,
    deleteTag,
    updateProject,
    updateTag,
  } from '../../lib/generated/sdk.gen'
  import {
    ensureProjects,
    ensureTags,
    ensureTimeEntries,
    projects as projectStore,
    tags as tagStore,
  } from '../../lib/store.js'
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
                class="meta rounded-md border border-white/15 px-3 py-2 hover:border-ember"
                onclick={() => removeTag(tag)}
              >
                Remove
              </button>
            </div>
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
