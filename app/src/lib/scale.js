/**
 * The tint a step carries on the answer ladder.
 *
 * Shared so the progress bar can echo the exact colour of the band that was
 * tapped, rather than approximating it.
 */
export function tint(ratio) {
  const clamped = Math.min(Math.max(ratio, 0), 1)
  return `color-mix(in oklab, var(--color-dusk-lift) ${12 + clamped * 58}%, transparent)`
}

/**
 * Where an answer sits on its question's scale, from 0 at the bottom to 1 at
 * the top. Returns null when the question is unanswered.
 */
export function answerRatio(question, answer) {
  if (!answer) return null
  if (question.kind === 'enum') {
    const index = question.options.findIndex((option) => option.id === answer.option_id)
    if (index < 0) return null
    return question.options.length > 1 ? index / (question.options.length - 1) : 1
  }
  if (answer.value == null) return null
  const low = question.min_value ?? 0
  const high = question.max_value ?? 5
  return high > low ? (answer.value - low) / (high - low) : 1
}
