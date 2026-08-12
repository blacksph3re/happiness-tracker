<script>
  // Matches the server's own limit, the same one questions obey.
  const PROMPT_MAX_LENGTH = 80

  /**
   * The one form used both to define a score and to edit an existing one.
   *
   * The draft's components are the questions a score may read — scaled ones
   * from this catalogue — every one of them listed with a checkbox, so the rule
   * shows up as an absence rather than as an error after saving.
   */
  let { draft, submitLabel, oncancel, onsubmit } = $props()

  const chosen = $derived(draft.components.filter((c) => c.include))
  // Bounds follow the definition, so the form can say what the axis will read
  // before anything is saved.
  const bounds = $derived.by(() => {
    const total = chosen.reduce((sum, c) => sum + Number(c.weight || 0), 0)
    const low = chosen.reduce((sum, c) => sum + c.min_value * Number(c.weight || 0), 0)
    const high = chosen.reduce((sum, c) => sum + c.max_value * Number(c.weight || 0), 0)
    if (draft.aggregate === 'mean') {
      return total ? [low / total, high / total] : [0, 0]
    }
    return [low, high]
  })

  function tidy(value) {
    return Number.isInteger(value) ? value : value.toFixed(2)
  }

  function submit(event) {
    event.preventDefault()
    onsubmit(draft)
  }
</script>

<form class="rounded-xl border border-white/10 bg-ink-soft p-6" onsubmit={submit}>
  <label class="flex flex-col gap-1.5">
    <span class="meta">Name</span>
    <input
      bind:value={draft.prompt}
      required
      maxlength={PROMPT_MAX_LENGTH}
      class="rounded-lg border border-white/15 bg-ink px-4 py-3"
    />
  </label>

  <label class="mt-3 flex flex-col gap-1.5">
    <span class="meta">Combine by</span>
    <select
      bind:value={draft.aggregate}
      class="rounded-lg border border-white/15 bg-ink px-4 py-3"
    >
      <option value="sum">Total — add the answers up</option>
      <option value="mean">Average — divide by the weights</option>
    </select>
  </label>

  <div class="mt-4 flex flex-col gap-2">
    <span class="meta">Questions that count</span>
    {#each draft.components as component (component.source_question_id)}
      <div class="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2">
        <label class="flex min-w-0 flex-1 items-center gap-3">
          <input type="checkbox" bind:checked={component.include} class="accent-dusk" />
          <span class="min-w-0 truncate {component.include ? '' : 'text-haze'}">
            {component.prompt}
          </span>
        </label>
        <label class="flex shrink-0 items-center gap-2">
          <span class="meta">Weight</span>
          <input
            type="number"
            step="0.1"
            bind:value={component.weight}
            disabled={!component.include}
            aria-label="Weight of {component.prompt}"
            class="numeral w-20 rounded-md border border-white/15 bg-ink px-2 py-1.5
                   disabled:opacity-40"
          />
        </label>
      </div>
    {:else}
      <p class="text-sm text-haze">
        This catalogue has no scaled questions yet. A score reads numbers, so options
        questions cannot feed one.
      </p>
    {/each}
  </div>

  <label class="mt-4 flex items-start gap-3">
    <input type="checkbox" bind:checked={draft.require_all} class="mt-1 accent-dusk" />
    <span class="text-sm">
      Only score a day where every question above was answered.
      <span class="block text-haze">
        Off, a day is scored from whatever is there — which reads lower than a full
        day rather than as missing.
      </span>
    </span>
  </label>

  {#if chosen.length}
    <p class="meta mt-4 normal-case">
      Reads {tidy(bounds[0])} to {tidy(bounds[1])} over {chosen.length}
      {chosen.length === 1 ? 'question' : 'questions'}.
    </p>
  {/if}

  <div class="mt-5 flex items-center gap-3">
    <button
      type="submit"
      disabled={chosen.length === 0}
      class="rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift
             disabled:cursor-not-allowed disabled:opacity-30"
    >
      {submitLabel}
    </button>
    {#if oncancel}
      <button
        type="button"
        class="meta rounded-md border border-white/15 px-4 py-3 hover:border-white/40"
        onclick={oncancel}
      >
        Cancel
      </button>
    {/if}
  </div>
</form>
