<script>
  import { api, tryApi } from '../lib/api.js'
  import { pushToast } from '../lib/toasts.js'

  let catalogues = $state([])
  let selectedId = $state(null)
  let detail = $state(null)
  let loading = $state(true)
  let newName = $state('')
  let draft = $state(blankDraft())

  const questions = $derived(
    detail ? detail.questions.filter((q) => !q.system_key) : []
  )

  function blankDraft() {
    return {
      kind: 'discrete',
      prompt: '',
      min_value: 1,
      max_value: 5,
      min_label: 'Low',
      max_label: 'High',
      options: ['', ''],
    }
  }

  $effect(() => {
    load()
  })

  async function load() {
    try {
      catalogues = (await tryApi('/catalogues')) ?? []
      selectedId ??= catalogues[0]?.id ?? null
      if (selectedId) detail = await tryApi(`/catalogues/${selectedId}`)
    } finally {
      loading = false
    }
  }

  async function select(id) {
    selectedId = id
    detail = await tryApi(`/catalogues/${id}`)
  }

  async function addCatalogue() {
    const created = await tryApi('/catalogues', {
      method: 'POST',
      body: { name: newName },
    })
    if (!created) return
    newName = ''
    catalogues = (await tryApi('/catalogues')) ?? []
    await select(created.id)
    pushToast(`Created ${created.name}`, 'ok')
  }

  async function addQuestion(event) {
    event.preventDefault()
    const body = { kind: draft.kind, prompt: draft.prompt, position: questions.length }
    if (draft.kind === 'enum') {
      body.options = draft.options
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label, position) => ({ label, position }))
    } else {
      Object.assign(body, {
        min_value: Number(draft.min_value),
        max_value: Number(draft.max_value),
        min_label: draft.min_label,
        max_label: draft.max_label,
      })
    }
    try {
      await api(`/catalogues/${selectedId}/questions`, { method: 'POST', body })
      draft = blankDraft()
      detail = await tryApi(`/catalogues/${selectedId}`)
      pushToast('Question added', 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }

  async function setActive(question, active) {
    try {
      await api(`/questions/${question.id}`, { method: 'PUT', body: { active } })
      detail = await tryApi(`/catalogues/${selectedId}`)
    } catch (error) {
      pushToast(error.message)
    }
  }

  async function addOption(question) {
    const label = prompt('New option')
    if (!label) return
    try {
      await api(`/questions/${question.id}/options`, { method: 'POST', body: { label } })
      detail = await tryApi(`/catalogues/${selectedId}`)
    } catch (error) {
      // The freeze rule answers with a 409 and an explanation of what to do instead.
      pushToast(error.message)
    }
  }

  function describe(question) {
    if (question.kind === 'enum') {
      return question.options.map((option) => option.label).join(' · ')
    }
    return `${question.min_value}–${question.max_value} · ${question.min_label} → ${question.max_label}`
  }
</script>

<section class="mx-auto w-full max-w-4xl px-5 py-8">
  <p class="meta">What everyone answers</p>
  <h1 class="mt-1 mb-8 text-3xl font-bold tracking-tight">Questions</h1>

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <div class="mb-6 flex flex-wrap items-center gap-2">
      {#each catalogues as catalogue (catalogue.id)}
        <button
          class="meta rounded-md border px-4 py-2 transition
                 {catalogue.id === selectedId
            ? 'border-ember bg-ember/10 text-paper'
            : 'border-white/15 hover:border-white/40'}"
          onclick={() => select(catalogue.id)}
        >
          {catalogue.name}
        </button>
      {/each}
      <span class="ml-auto flex items-center gap-2">
        <input
          bind:value={newName}
          placeholder="New catalogue"
          class="rounded-md border border-white/15 bg-ink-soft px-3 py-2 text-sm"
        />
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                 disabled:opacity-30"
          disabled={!newName.trim()}
          onclick={addCatalogue}
        >
          Add
        </button>
      </span>
    </div>

    <ul class="flex flex-col gap-2">
      {#each questions as question (question.id)}
        <li
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                 border-white/10 bg-ink-soft px-5 py-4 {question.active ? '' : 'opacity-50'}"
        >
          <div class="min-w-0">
            <p class="font-medium">{question.prompt}</p>
            <p class="meta mt-1 normal-case">{describe(question)}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            {#if question.kind === 'enum'}
              <button class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
                onclick={() => addOption(question)}>Add option</button>
            {/if}
            <button
              class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
              onclick={() => setActive(question, !question.active)}
            >
              {question.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
        </li>
      {:else}
        <li class="rounded-lg border border-white/10 bg-ink-soft px-5 py-8 text-haze">
          No questions yet. Add the first one below.
        </li>
      {/each}
    </ul>

    <form class="mt-8 rounded-xl border border-white/10 bg-ink-soft p-6" onsubmit={addQuestion}>
      <h2 class="font-semibold">Add a question</h2>
      <p class="mt-1 text-sm text-haze">
        Scale and options are fixed once the first answer is recorded, so history stays
        readable.
      </p>

      <label class="mt-4 flex flex-col gap-1.5">
        <span class="meta">Question</span>
        <input
          bind:value={draft.prompt}
          required
          class="rounded-lg border border-white/15 bg-ink px-4 py-3"
        />
      </label>

      <label class="mt-3 flex flex-col gap-1.5">
        <span class="meta">Kind</span>
        <select bind:value={draft.kind} class="rounded-lg border border-white/15 bg-ink px-4 py-3">
          <option value="discrete">Discrete — whole steps on a scale</option>
          <option value="continuous">Continuous — anywhere on a scale</option>
          <option value="enum">Options — no order between them</option>
        </select>
      </label>

      {#if draft.kind === 'enum'}
        <div class="mt-3 flex flex-col gap-2">
          <span class="meta">Options</span>
          {#each draft.options as _, position}
            <input
              bind:value={draft.options[position]}
              placeholder={`Option ${position + 1}`}
              class="rounded-lg border border-white/15 bg-ink px-4 py-3"
            />
          {/each}
          <button
            type="button"
            class="meta self-start rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
            onclick={() => (draft.options = [...draft.options, ''])}
          >
            Another option
          </button>
        </div>
      {:else}
        <div class="mt-3 grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1.5">
            <span class="meta">Lowest value</span>
            <input type="number" bind:value={draft.min_value}
              class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="meta">Highest value</span>
            <input type="number" bind:value={draft.max_value}
              class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="meta">Means at the low end</span>
            <input bind:value={draft.min_label}
              class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="meta">Means at the high end</span>
            <input bind:value={draft.max_label}
              class="rounded-lg border border-white/15 bg-ink px-4 py-3" />
          </label>
        </div>
      {/if}

      <button type="submit" class="mt-5 rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift">
        Add question
      </button>
    </form>
  {/if}
</section>
