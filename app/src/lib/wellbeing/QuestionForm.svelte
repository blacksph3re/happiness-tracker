<script>
  import IconPicker from '../IconPicker.svelte'
  import { targetLabel } from '../habits.js'

  // Matches the server's own limit; the questionnaire's layout is built
  // around it, so the form says so rather than letting a save fail.
  const PROMPT_MAX_LENGTH = 80

  /**
   * The one form used both to add a question and to edit an existing one, so
   * adding an enum option happens in the same place it was first defined
   * rather than in a browser dialog.
   *
   * `frozen` disables everything that the backend refuses to change once the
   * question has been answered, and says why. The habit controls are
   * deliberately outside that: marking an option as counted, or changing a
   * target, is a definition over answers that are already correct, and a
   * definition change is retroactive here by design.
   */
  let { draft, frozen = false, submitLabel, oncancel, onsubmit } = $props()

  // Reading the label back from the same function the streak rows use, so the
  // sentence under the controls cannot drift from what is actually scored.
  const summary = $derived(
    draft.habit
      ? targetLabel({
          period: draft.habit_period,
          target: Number(draft.habit_target),
          direction: draft.habit_direction,
        })
      : null
  )

  const counted = $derived(
    draft.options
      .map((label, index) => ({ label: label.trim(), index }))
      .filter(({ index }) => draft.counts?.[index])
      .map(({ label }) => label)
      .filter(Boolean)
  )

  function submit(event) {
    event.preventDefault()
    onsubmit(draft)
  }

  function toggleCount(position) {
    const next = [...(draft.counts ?? [])]
    next[position] = !next[position]
    draft.counts = next
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
      maxlength={PROMPT_MAX_LENGTH}
      class="rounded-lg border border-white/15 bg-ink px-4 py-3"
    />
    <span class="meta normal-case">
      <!-- The questionnaire reserves room for this much, so a longer question
           would push the answers down the page: that is the reason for the cap,
           and the counter is all the field needs to say. -->
      {(draft.prompt ?? '').length}/{PROMPT_MAX_LENGTH} characters
    </span>
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
        <span class="flex items-stretch gap-2">
          <input
            bind:value={draft.options[position]}
            placeholder={`Option ${position + 1}`}
            disabled={frozen && position < (draft.lockedOptions ?? 0)}
            class="flex-1 rounded-lg border border-white/15 bg-ink px-4 py-3 disabled:opacity-50"
          />
          {#if draft.habit}
            <!-- Enabled even when frozen, and that is the point: adding a
                 choice would reinterpret the recorded answers, while saying
                 which choices count says what those answers *mean* for a
                 streak. A definition, and definitions are retroactive here. -->
            <button
              type="button"
              data-counts={Boolean(draft.counts?.[position])}
              aria-pressed={Boolean(draft.counts?.[position])}
              class="meta flex items-center gap-2 rounded-md border px-3 transition
                     {draft.counts?.[position]
                       ? 'border-sage bg-sage/15 text-paper'
                       : 'border-white/15 hover:border-white/40'}"
              onclick={() => toggleCount(position)}
            >
              {draft.counts?.[position] ? '✓' : '·'} counts
            </button>
          {/if}
          {#if !frozen && draft.options.length > 2}
            <button
              type="button"
              class="btn-outline meta"
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
        class="btn-outline meta self-start disabled:opacity-30"
        onclick={() => (draft.options = [...draft.options, ''])}
      >
        Another option
      </button>
    </div>

    <div class="mt-4 rounded-lg border border-white/10 p-4">
      <label class="flex items-center gap-3">
        <input
          type="checkbox"
          bind:checked={draft.habit}
          class="size-4 accent-dusk-lift"
        />
        <span class="meta">Track as a habit</span>
      </label>

      {#if draft.habit}
        <!-- The search and the choice are two different things, and the form
             used to make them one field: you typed into the preview, so
             anything you typed *was* the icon and a habit could be labelled
             "AAAA". The shared picker is that separation — the box takes words,
             the row takes the choice, and there is no free-text path to the
             stored value at all. Cleared as `''` rather than `null`, because
             `model_fields_set` is what tells "no icon" from "leave alone" and
             the draft has to send the field either way. -->
        <div class="mt-4">
          <IconPicker value={draft.icon} onchange={(icon) => (draft.icon = icon ?? '')} />
        </div>

        <div class="mt-3 flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1.5">
            <span class="meta">Aim for</span>
            <select
              bind:value={draft.habit_direction}
              class="rounded-lg border border-white/15 bg-ink px-4 py-3"
            >
              <option value="at_least">At least</option>
              <option value="at_most">At most</option>
            </select>
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="meta">Times</span>
            <input
              type="number"
              min={draft.habit_direction === 'at_most' ? 0 : 1}
              bind:value={draft.habit_target}
              aria-label="Habit target"
              class="w-24 rounded-lg border border-white/15 bg-ink px-4 py-3"
            />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="meta">Per</span>
            <select
              bind:value={draft.habit_period}
              class="rounded-lg border border-white/15 bg-ink px-4 py-3"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
        </div>

        <!-- In words, because `at most 0` is the setting most likely to be read
             backwards, and because a row of green means the opposite thing
             under a habit you are trying to stop. -->
        <p class="meta mt-3 normal-case" data-habit-summary>
          {#if counted.length === 0}
            Nothing counts yet — tick the options that mean you did it.
          {:else}
            {counted.join(' and ')}
            {counted.length === 1 ? 'counts' : 'count'}. A {draft.habit_period} needs
            {summary?.replace(` / ${draft.habit_period}`, '')} to keep the streak.
          {/if}
        </p>
      {/if}
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
    <button type="submit" class="btn-filled">
      {submitLabel}
    </button>
    {#if oncancel}
      <button
        type="button"
        class="btn-outline meta"
        onclick={oncancel}
      >
        Cancel
      </button>
    {/if}
  </div>
</form>
