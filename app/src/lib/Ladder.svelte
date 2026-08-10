<script>
  /**
   * The answer scale, rendered as full-bleed bands: one tap answers.
   *
   * Bands stack vertically on tall screens and run horizontally on wide ones,
   * which is the responsive rule the brief asks for falling out of the layout
   * rather than being bolted onto it.
   */
  let { question, value, onanswer } = $props()

  const steps = $derived(buildSteps(question))

  // Bands stop being tappable targets past about a dozen; anything wider, and
  // anything continuous, is answered by dragging instead.
  const useSlider = $derived(
    question.kind === 'continuous' ||
      (question.kind !== 'enum' && (question.max_value ?? 5) - (question.min_value ?? 1) > 10)
  )

  let sliderValue = $state(null)

  /**
   * Build one band per selectable step.
   *
   * @param {object} q The question being answered.
   * @returns {Array<object>} Bands with their labels and answer payloads.
   */
  function buildSteps(q) {
    if (q.kind === 'enum') {
      return q.options.map((option) => ({
        key: option.id,
        label: option.label,
        payload: { option_id: option.id },
      }))
    }
    const low = q.min_value ?? 1
    const high = q.max_value ?? 5
    const count = Math.round(high - low) + 1
    return Array.from({ length: count }, (_, index) => {
      const step = low + index
      return {
        key: step,
        label: String(step),
        edge: index === 0 ? q.min_label : index === count - 1 ? q.max_label : null,
        payload: { value: step },
      }
    })
  }

  /**
   * Report whether a band is the currently recorded answer.
   *
   * @param {object} step One band.
   * @returns {boolean} True when it matches the stored answer.
   */
  function isChosen(step) {
    if (question.kind === 'enum') return value?.option_id === step.key
    return value?.value === step.key
  }

  /**
   * Deepen the band tint as the scale climbs, so the ladder reads as a gradient.
   *
   * @param {number} index Position of the band.
   * @returns {string} A CSS colour.
   */
  function tint(index) {
    const ratio = steps.length === 1 ? 1 : index / (steps.length - 1)
    return `color-mix(in oklab, var(--color-dusk-lift) ${12 + ratio * 58}%, transparent)`
  }
</script>

{#if useSlider}
  <!-- One drag answers a continuous question, matching the one-interaction rule. -->
  <div class="rounded-lg border border-white/10 bg-ink-soft px-6 py-8">
    <div class="mb-6 flex items-baseline justify-between">
      <span class="meta">{question.min_label ?? question.min_value}</span>
      <span class="numeral text-5xl">
        {(sliderValue ?? value?.value ?? (question.min_value + question.max_value) / 2).toFixed(1)}
      </span>
      <span class="meta">{question.max_label ?? question.max_value}</span>
    </div>
    <input
      type="range"
      class="h-2 w-full cursor-pointer appearance-none rounded-full bg-dusk-deep accent-ember"
      min={question.min_value}
      max={question.max_value}
      step={(question.max_value - question.min_value) / 100}
      value={value?.value ?? (question.min_value + question.max_value) / 2}
      aria-label={question.prompt}
      oninput={(event) => (sliderValue = Number(event.currentTarget.value))}
      onchange={(event) => onanswer({ value: Number(event.currentTarget.value) })}
    />
  </div>
{:else}
<div class="flex flex-col gap-1.5 md:flex-row md:gap-2" role="group" aria-label={question.prompt}>
  {#each steps as step, index (step.key)}
    <button
      type="button"
      onclick={() => onanswer(step.payload)}
      aria-pressed={isChosen(step)}
      style:background={tint(index)}
      class="group relative flex min-h-16 flex-1 items-center justify-between gap-3 rounded-lg border px-5
             py-4 text-left transition duration-150 ease-out
             md:min-h-56 md:flex-col md:items-start md:justify-end md:px-4 md:py-5
             {isChosen(step)
        ? 'border-ember ring-2 ring-ember/60'
        : 'border-white/10 hover:border-white/30 hover:brightness-125'}"
    >
      <span
        class="numeral text-3xl text-paper md:text-5xl
               {question.kind === 'enum' ? 'text-lg font-semibold md:text-2xl' : ''}"
      >
        {step.label}
      </span>
      {#if step.edge}
        <span class="meta md:mt-1">{step.edge}</span>
      {/if}
    </button>
  {/each}
</div>
{/if}
