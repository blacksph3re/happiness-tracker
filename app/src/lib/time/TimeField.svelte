<script>
  /**
   * A clock time, with steppers.
   *
   * The underlying control is still `input[type=time]`, so a tap opens the
   * platform's own picker — but a browser draws that input with no affordance
   * at all (the date input beside it at least gets a calendar icon), so it
   * reads as a text box and invites typing into it on a phone. The two buttons
   * are the visible half: correcting a session by a few minutes, which is most
   * corrections, takes taps rather than a picker.
   */
  let { value = $bindable(), label, step = 5 } = $props()

  /** Turn `HH:MM` into minutes since midnight, tolerating an empty field. */
  function toMinutes(clock) {
    const [hours, minutes] = (clock || '00:00').split(':').map(Number)
    return hours * 60 + minutes
  }

  /**
   * Nudge the time, stopping at the ends of the day.
   *
   * Clamped rather than wrapped: rolling 23:55 round to 00:00 would move the
   * session to a different day without saying so.
   */
  function nudge(direction) {
    const minutes = Math.min(24 * 60 - 1, Math.max(0, toMinutes(value) + direction * step))
    value = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
      minutes % 60
    ).padStart(2, '0')}`
  }
</script>

<span class="flex items-stretch">
  <button
    type="button"
    aria-label="{label} {step} minutes earlier"
    class="meta rounded-l-lg border border-r-0 border-white/15 px-2.5 hover:border-white/40"
    onclick={() => nudge(-1)}
  >
    −
  </button>
  <input
    type="time"
    aria-label={label}
    bind:value
    class="w-full min-w-0 border-y border-white/15 bg-ink px-2 py-2 text-sm"
  />
  <button
    type="button"
    aria-label="{label} {step} minutes later"
    class="meta rounded-r-lg border border-l-0 border-white/15 px-2.5 hover:border-white/40"
    onclick={() => nudge(1)}
  >
    +
  </button>
</span>
