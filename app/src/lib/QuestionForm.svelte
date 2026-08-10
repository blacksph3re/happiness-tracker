<script>
  /**
   * The one form used both to add a question and to edit an existing one, so
   * adding an enum option happens in the same place it was first defined
   * rather than in a browser dialog.
   *
   * `frozen` disables everything that the backend refuses to change once the
   * question has been answered, and says why.
   */
  let { draft, frozen = false, submitLabel, oncancel, onsubmit } = $props()

  function submit(event) {
    event.preventDefault()
    onsubmit(draft)
  }
</script>

<form class="rounded-xl border border-white/10 bg-ink-soft p-6" onsubmit={submit}>
  {#if frozen}
    <p class="mb-4 rounded-lg border border-ember/40 bg-ember/10 px-4 py-3 text-sm">
      This question has answers, so its scale and options are fixed. You can still
      change the wording.
    </p>
  {/if}

  <label class="flex flex-col gap-1.5">
    <span class="meta">Question</span>
    <input
      bind:value={draft.prompt}
      required
      class="rounded-lg border border-white/15 bg-ink px-4 py-3"
    />
  </label>

  <label class="mt-3 flex flex-col gap-1.5">
    <span class="meta">Kind</span>
    <select
      bind:value={draft.kind}
      disabled={frozen || Boolean(draft.id)}
      class="rounded-lg border border-white/15 bg-ink px-4 py-3 disabled:opacity-50"
    >
      <option value="discrete">Discrete — whole steps on a scale</option>
      <option value="continuous">Continuous — anywhere on a scale</option>
      <option value="enum">Options — no order between them</option>
    </select>
  </label>

  {#if draft.kind === 'enum'}
    <div class="mt-3 flex flex-col gap-2">
      <span class="meta">Options</span>
      {#each draft.options as _, position}
        <span class="flex gap-2">
          <input
            bind:value={draft.options[position]}
            placeholder={`Option ${position + 1}`}
            disabled={frozen && position < (draft.lockedOptions ?? 0)}
            class="flex-1 rounded-lg border border-white/15 bg-ink px-4 py-3 disabled:opacity-50"
          />
          {#if !frozen && draft.options.length > 2}
            <button
              type="button"
              class="meta rounded-md border border-white/15 px-3 hover:border-white/40"
              aria-label={`Remove option ${position + 1}`}
              onclick={() => (draft.options = draft.options.filter((_, i) => i !== position))}
            >
              ×
            </button>
          {/if}
        </span>
      {/each}
      <button
        type="button"
        disabled={frozen}
        class="meta self-start rounded-md border border-white/15 px-3 py-2
               hover:border-white/40 disabled:opacity-30"
        onclick={() => (draft.options = [...draft.options, ''])}
      >
        Another option
      </button>
    </div>
  {:else}
    <div class="mt-3 grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="meta">Lowest value</span>
        <input type="number" bind:value={draft.min_value} disabled={frozen}
          class="rounded-lg border border-white/15 bg-ink px-4 py-3 disabled:opacity-50" />
      </label>
      <label class="flex flex-col gap-1.5">
        <span class="meta">Highest value</span>
        <input type="number" bind:value={draft.max_value} disabled={frozen}
          class="rounded-lg border border-white/15 bg-ink px-4 py-3 disabled:opacity-50" />
      </label>
      <label class="flex flex-col gap-1.5">
        <span class="meta">Means at the low end</span>
        <input bind:value={draft.min_label} disabled={frozen}
          class="rounded-lg border border-white/15 bg-ink px-4 py-3 disabled:opacity-50" />
      </label>
      <label class="flex flex-col gap-1.5">
        <span class="meta">Means at the high end</span>
        <input bind:value={draft.max_label} disabled={frozen}
          class="rounded-lg border border-white/15 bg-ink px-4 py-3 disabled:opacity-50" />
      </label>
    </div>
  {/if}

  <div class="mt-5 flex items-center gap-3">
    <button type="submit" class="rounded-lg bg-dusk px-5 py-3 font-semibold hover:bg-dusk-lift">
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
