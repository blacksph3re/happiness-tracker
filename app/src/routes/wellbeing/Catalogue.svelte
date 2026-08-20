<script>
  import AdminOffline, { OFFLINE_HINT } from '../../lib/AdminOffline.svelte'
  import IconBin from '../../lib/IconBin.svelte'
  import IconPencil from '../../lib/IconPencil.svelte'
  import IconPlus from '../../lib/IconPlus.svelte'
  import QuestionForm from '../../lib/wellbeing/QuestionForm.svelte'
  import ScoreForm from '../../lib/wellbeing/ScoreForm.svelte'
  import { attempt, unwrap } from '../../lib/api.js'
  import { resource } from '../../lib/resource.svelte.js'
  import {
    addQuestionOption,
    createCatalogue as createCatalogueCall,
    createQuestion,
    createScore,
    deleteScore,
    listCatalogueTemplates,
    renameCatalogue as renameCatalogueCall,
    updateQuestion,
    updateScore,
  } from '../../lib/generated/sdk.gen'
  import {
    ensureAnswers,
    ensureCatalogue,
    ensureCatalogues,
    ensureVariables,
  } from '../../lib/store.js'
  import { connection } from '../../lib/sync.js'
  import { pushToast } from '../../lib/toasts.js'

  let catalogues = $state([])
  let selectedId = $state(null)
  let detail = $state(null)
  /** Questions are shared by everyone, so none of this queues — see AdminOffline. */
  const offline = $derived($connection !== 'online')

  /** Set on every control the connection is holding down, and on no other. */
  const hint = $derived(offline ? OFFLINE_HINT : undefined)

  let loading = $state(true)
  let newName = $state('')

  /** Which starter set a newly created catalogue is filled from, or none. */
  let newTemplate = $state('')

  // Offered here as well as at account creation: a second catalogue would
  // otherwise start empty, and rebuilding a known instrument by hand is the
  // work a template exists to save.
  const templates = resource(
    () => null,
    () => attempt(() => listCatalogueTemplates()),
    { name: 'catalogue templates', initial: [] }
  )
  const starters = $derived(templates.data ?? [])
  let renaming = $state(false)
  let renameValue = $state('')
  let draft = $state(blankDraft())
  let editing = $state(null)
  let scoreDraft = $state(null)
  let editingScore = $state(null)

  const questions = $derived(
    detail ? detail.questions.filter((q) => q.origin === 'asked') : []
  )
  const scores = $derived(
    detail ? detail.questions.filter((q) => q.origin === 'computed') : []
  )
  // A score reads numbers, so an options question has nothing to contribute.
  const scorable = $derived(questions.filter((q) => q.kind !== 'enum'))

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

  /** Turn a saved question back into the shape the shared form edits. */
  function toDraft(question) {
    return {
      id: question.id,
      kind: question.kind,
      prompt: question.prompt,
      min_value: question.min_value ?? 1,
      max_value: question.max_value ?? 5,
      min_label: question.min_label ?? '',
      max_label: question.max_label ?? '',
      options: question.options.map((option) => option.label),
      // Existing options cannot be renamed or removed through the API, so the
      // form locks them and only accepts additions.
      lockedOptions: question.options.length,
      optionIds: question.options.map((option) => option.id),
      answered: question.answered ?? false,
    }
  }

  async function edit(question) {
    editing = toDraft(question)
    // The freeze rule is a server-side fact, so ask rather than guess: a probe
    // update of a field the server always accepts reveals nothing, so instead
    // the answered flag comes from whether any answer references the question.
    const rows = (await ensureAnswers()) ?? []
    editing.answered = rows.some((row) => row.question_id === question.id)
  }

  async function saveEdit(edited) {
    try {
      await unwrap(() =>
        updateQuestion({
          path: { question_id: edited.id },
          body: edited.answered
            ? { prompt: edited.prompt }
            : {
                prompt: edited.prompt,
                ...(edited.kind === 'enum'
                  ? {}
                  : {
                      min_value: Number(edited.min_value),
                      max_value: Number(edited.max_value),
                      min_label: edited.min_label,
                      max_label: edited.max_label,
                    }),
              },
        })
      )
      if (edited.kind === 'enum') {
        const added = edited.options.slice(edited.lockedOptions)
        for (const label of added.map((l) => l.trim()).filter(Boolean)) {
          await unwrap(() =>
            addQuestionOption({ path: { question_id: edited.id }, body: { label } })
          )
        }
      }
      editing = null
      detail = await ensureCatalogue(selectedId, { force: true })
      pushToast('Question saved', 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }

  $effect(() => {
    load()
  })

  async function load() {
    try {
      catalogues = (await ensureCatalogues({ force: true })) ?? []
      selectedId ??= catalogues[0]?.id ?? null
      if (selectedId) detail = await ensureCatalogue(selectedId, { force: true })
    } finally {
      loading = false
    }
  }

  async function select(id) {
    selectedId = id
    detail = await ensureCatalogue(id, { force: true })
  }

  /** Put the input straight into use, so renaming is one click and then typing. */
  function focusOnMount(node) {
    node.focus()
    node.select()
  }

  function startRename() {
    renameValue = catalogues.find((c) => c.id === selectedId)?.name ?? ''
    renaming = true
  }

  async function renameCatalogue() {
    const name = renameValue.trim()
    const current = catalogues.find((c) => c.id === selectedId)
    if (!name || name === current?.name) {
      renaming = false
      return
    }
    // A clashing name comes back as a 409, which attempt surfaces as a toast.
    const updated = await attempt(() =>
      renameCatalogueCall({ path: { catalogue_id: selectedId }, body: { name } })
    )
    if (!updated) return
    renaming = false
    catalogues = (await ensureCatalogues({ force: true })) ?? []
    if (detail) detail = { ...detail, name: updated.name }
    pushToast(`Renamed to ${updated.name}`, 'ok')
  }

  async function addCatalogue() {
    const created = await attempt(() =>
      createCatalogueCall({
        body: { name: newName, template: newTemplate || null },
      })
    )
    if (!created) return
    newName = ''
    newTemplate = ''
    catalogues = (await ensureCatalogues({ force: true })) ?? []
    await select(created.id)
    pushToast(`Created ${created.name}`, 'ok')
  }

  async function addQuestion(submitted) {
    const body = {
      kind: submitted.kind,
      prompt: submitted.prompt,
      position: questions.length,
    }
    if (submitted.kind === 'enum') {
      body.options = submitted.options
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label, position) => ({ label, position }))
    } else {
      Object.assign(body, {
        min_value: Number(submitted.min_value),
        max_value: Number(submitted.max_value),
        min_label: submitted.min_label,
        max_label: submitted.max_label,
      })
    }
    try {
      await unwrap(() =>
        createQuestion({ path: { catalogue_id: selectedId }, body })
      )
      draft = blankDraft()
      detail = await ensureCatalogue(selectedId, { force: true })
      pushToast('Question added', 'ok')
    } catch (error) {
      pushToast(error.message)
    }
  }

  // Positions can be sparse or duplicated after edits, so a move rewrites the
  // whole run as 0..n-1 rather than trusting the existing numbers.
  async function move(question, delta) {
    const ordered = [...questions]
    const from = ordered.findIndex((q) => q.id === question.id)
    const to = from + delta
    if (to < 0 || to >= ordered.length) return
    ordered.splice(to, 0, ordered.splice(from, 1)[0])
    try {
      for (const [position, item] of ordered.entries()) {
        if (item.position !== position) {
          await unwrap(() =>
            updateQuestion({ path: { question_id: item.id }, body: { position } })
          )
        }
      }
      detail = await ensureCatalogue(selectedId, { force: true })
    } catch (error) {
      pushToast(error.message)
    }
  }

  async function setActive(question, active) {
    try {
      await unwrap(() =>
        updateQuestion({ path: { question_id: question.id }, body: { active } })
      )
      detail = await ensureCatalogue(selectedId, { force: true })
    } catch (error) {
      pushToast(error.message)
    }
  }

  /**
   * Build the editable shape of a score: every scorable question listed, with
   * the ones this score already reads ticked.
   *
   * @param {object|null} score An existing score, or null for a new one.
   */
  function toScoreDraft(score) {
    const weights = new Map(
      (score?.components ?? []).map((c) => [c.source_question_id, c.weight])
    )
    return {
      id: score?.id,
      prompt: score?.prompt ?? '',
      aggregate: score?.aggregate ?? 'sum',
      require_all: score?.require_all ?? true,
      components: scorable.map((question) => ({
        source_question_id: question.id,
        prompt: question.prompt,
        min_value: question.min_value,
        max_value: question.max_value,
        include: score ? weights.has(question.id) : true,
        weight: weights.get(question.id) ?? 1,
      })),
    }
  }

  function scoreBody(edited) {
    return {
      prompt: edited.prompt,
      aggregate: edited.aggregate,
      require_all: edited.require_all,
      components: edited.components
        .filter((c) => c.include)
        .map((c) => ({
          source_question_id: c.source_question_id,
          weight: Number(c.weight),
        })),
    }
  }

  async function saveScore(edited) {
    const saved = await attempt(() =>
      edited.id
        ? updateScore({ path: { score_id: edited.id }, body: scoreBody(edited) })
        : createScore({
            path: { catalogue_id: selectedId },
            // Scores sort after the questions they read and before the
            // auto-tracked block, which starts at 1000.
            body: { ...scoreBody(edited), position: 500 + scores.length },
          })
    )
    if (!saved) return
    scoreDraft = null
    editingScore = null
    detail = await ensureCatalogue(selectedId, { force: true })
    await refreshDerived()
    pushToast(edited.id ? 'Score saved' : 'Score added', 'ok')
  }

  async function removeScore(score) {
    // A 204 unwraps to null, which is also what a failure returns, so this one
    // reads the exception rather than the value.
    try {
      await unwrap(() => deleteScore({ path: { score_id: score.id } }))
    } catch (error) {
      pushToast(error.message)
      return
    }
    detail = await ensureCatalogue(selectedId, { force: true })
    await refreshDerived()
    pushToast(`Removed ${score.prompt}`, 'ok')
  }

  async function setScoreActive(score, active) {
    const saved = await attempt(() =>
      updateScore({ path: { score_id: score.id }, body: { active } })
    )
    if (!saved) return
    detail = await ensureCatalogue(selectedId, { force: true })
    await refreshDerived()
  }

  /**
   * Reload what a score definition changes.
   *
   * Scores are worked out on read, so editing one silently rewrites the values
   * the store is already holding for the record table and the stats page.
   */
  async function refreshDerived() {
    await Promise.all([
      ensureAnswers({ force: true }),
      ensureVariables({ force: true }),
    ])
  }

  /** Say what a score adds up, in the words of the questions it reads. */
  function describeScore(score) {
    const named = new Map(questions.map((q) => [q.id, q.prompt]))
    const parts = score.components.map((component) => {
      const prompt = named.get(component.source_question_id) ?? 'a removed question'
      return component.weight === 1 ? prompt : `${component.weight} × ${prompt}`
    })
    const how = score.aggregate === 'mean' ? 'Average of' : 'Total of'
    return `${how} ${parts.join(' · ')}`
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

  <AdminOffline does="Questions are the same for everyone who answers them" />

  {#if loading}
    <p class="meta">Loading…</p>
  {:else}
    <div class="mb-6 flex flex-wrap items-center gap-2">
      {#if renaming}
        <input
          bind:value={renameValue}
          use:focusOnMount
          aria-label="Catalogue name"
          onkeydown={(event) => {
            if (event.key === 'Enter') renameCatalogue()
            if (event.key === 'Escape') renaming = false
          }}
          class="rounded-md border border-ember bg-ink-soft px-3 py-2 text-sm"
        />
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                 disabled:opacity-30"
          disabled={offline || !renameValue.trim()}
          title={hint}
          onclick={renameCatalogue}
        >
          Save
        </button>
        <button
          class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
          onclick={() => (renaming = false)}
        >
          Cancel
        </button>
      {:else}
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
        <span class="ml-auto flex flex-wrap items-center gap-2">
          {#if selectedId}
            <button
              disabled={offline}
              title={hint}
              class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                     disabled:cursor-not-allowed disabled:opacity-40"
              onclick={startRename}
            >
              Rename
            </button>
          {/if}
          <input
            bind:value={newName}
            placeholder="New catalogue"
            disabled={offline}
            title={hint}
            class="min-w-32 flex-1 rounded-md border border-white/15 bg-ink-soft px-3
                   py-2 text-sm sm:flex-none"
          />
          <select
            bind:value={newTemplate}
            disabled={offline}
            title={hint}
            aria-label="Starter set"
            class="rounded-md border border-white/15 bg-ink-soft px-3 py-2 text-sm"
          >
            <option value="">Empty</option>
            {#each starters as starter (starter.key)}
              <option value={starter.key}>{starter.name}</option>
            {/each}
          </select>
          <button
            class="meta rounded-md border border-white/15 p-2 hover:border-white/40
                   disabled:opacity-30"
            disabled={offline || !newName.trim()}
            title={hint || 'Add'}
            aria-label="Add"
            onclick={addCatalogue}
          >
            <IconPlus />
          </button>
        </span>
      {/if}
    </div>

    <ul class="flex flex-col gap-2">
      {#each questions as question, position (question.id)}
        <li
          data-question
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                 border-white/10 bg-ink-soft px-5 py-4 {question.active ? '' : 'opacity-50'}"
        >
          <div class="min-w-0">
            <p class="font-medium">{question.prompt}</p>
            <p class="meta mt-1 normal-case">{describe(question)}</p>
          </div>
          <div class="flex shrink-0 items-stretch gap-2">
            <span class="flex items-stretch gap-1">
              <button
                class="meta rounded-md border border-white/15 px-2 py-2 hover:border-white/40
                       disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="Move {question.prompt} earlier"
                disabled={offline || position === 0}
                title={hint}
                onclick={() => move(question, -1)}
              >
                ↑
              </button>
              <button
                class="meta rounded-md border border-white/15 px-2 py-2 hover:border-white/40
                       disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="Move {question.prompt} later"
                disabled={offline || position === questions.length - 1}
                title={hint}
                onclick={() => move(question, 1)}
              >
                ↓
              </button>
            </span>
            <button
              disabled={offline}
              title={hint || 'Edit'}
              aria-label="Edit"
              class="meta rounded-md border border-white/15 p-2 hover:border-white/40
                     disabled:cursor-not-allowed disabled:opacity-40"
              onclick={() => edit(question)}
            >
              <IconPencil />
            </button>
            <button
              disabled={offline}
              title={hint}
              class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                     disabled:cursor-not-allowed disabled:opacity-40"
              onclick={() => setActive(question, !question.active)}
            >
              {question.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
          {#if editing?.id === question.id}
            <div class="mt-4 w-full">
              <QuestionForm
                draft={editing}
                frozen={editing.answered}
                submitLabel="Save question"
                oncancel={() => (editing = null)}
                onsubmit={saveEdit}
              />
            </div>
          {/if}
        </li>
      {:else}
        <li class="rounded-lg border border-white/10 bg-ink-soft px-5 py-8 text-haze">
          No questions yet. Add the first one below.
        </li>
      {/each}
    </ul>

    <div class="mt-10">
      <h2 class="font-semibold">Scores</h2>
      <p class="mt-1 mb-3 text-sm text-haze">
        A score is worked out from the answers above rather than asked, so changing
        one applies to every day already recorded.
      </p>

      <ul class="flex flex-col gap-2">
        {#each scores as score (score.id)}
          <li
            data-score
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                   border-white/10 bg-ink-soft px-5 py-4 {score.active ? '' : 'opacity-50'}"
          >
            <div class="min-w-0">
              <p class="font-medium italic">{score.prompt}</p>
              <p class="meta mt-1 normal-case">{describeScore(score)}</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                disabled={offline}
                title={hint || 'Edit'}
                aria-label="Edit"
                class="meta rounded-md border border-white/15 p-2 hover:border-white/40
                     disabled:cursor-not-allowed disabled:opacity-40"
                onclick={() => {
                  scoreDraft = null
                  editingScore = toScoreDraft(score)
                }}
              >
                <IconPencil />
              </button>
              <button
                disabled={offline}
                title={hint}
                class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40
                     disabled:cursor-not-allowed disabled:opacity-40"
                onclick={() => setScoreActive(score, !score.active)}
              >
                {score.active ? 'Deactivate' : 'Reactivate'}
              </button>
              <button
                disabled={offline}
                title={hint || 'Remove'}
                aria-label="Remove"
                class="meta rounded-md border border-white/15 p-2 hover:border-white/40
                     disabled:cursor-not-allowed disabled:opacity-40"
                onclick={() => removeScore(score)}
              >
                <IconBin />
              </button>
            </div>
            {#if editingScore?.id === score.id}
              <div class="mt-4 w-full">
                <ScoreForm
                  draft={editingScore}
                  submitLabel="Save score"
                  oncancel={() => (editingScore = null)}
                  onsubmit={saveScore}
                />
              </div>
            {/if}
          </li>
        {/each}
      </ul>

      {#if scoreDraft}
        <div class="mt-3">
          <ScoreForm
            draft={scoreDraft}
            submitLabel="Add score"
            oncancel={() => (scoreDraft = null)}
            onsubmit={saveScore}
          />
        </div>
      {:else}
        <button
          class="meta mt-3 flex items-center gap-2 rounded-md border border-white/15 px-4
                 py-2 hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-30"
          disabled={offline || scorable.length === 0}
          title={hint}
          onclick={() => {
            editingScore = null
            scoreDraft = toScoreDraft(null)
          }}
        >
          <IconPlus class="size-3.5" />
          Add a score
        </button>
      {/if}
    </div>

    <div class="mt-10">
      <h2 class="mb-3 font-semibold">Add a question</h2>
      <p class="mb-3 text-sm text-haze">
        Scale and options are fixed once the first answer is recorded, so history stays
        readable.
      </p>
      <QuestionForm {draft} submitLabel="Add question" onsubmit={addQuestion} />
    </div>
  {/if}
</section>
