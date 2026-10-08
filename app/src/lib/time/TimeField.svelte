<script>
  import { rollClock, shiftDay } from '../day.js'

  /**
   * A clock time, with steppers.
   *
   * The underlying control is still `input[type=time]`, so a tap opens the
   * platform's own picker — but a browser draws that input with no affordance
   * at all (the date input beside it at least gets a calendar icon), so it
   * reads as a text box and invites typing into it on a phone. The two buttons
   * are the visible half: correcting a session by a few minutes, which is most
   * corrections, takes taps rather than a picker.
   *
   * Given the `day` beside it, a roll past midnight carries that day with it:
   * 00:00 stepped back is 23:55 of the day before. Deleting the second day of a
   * session leaves it ending at 00:00 on that day, and a stepper that stopped
   * there — or a typed 23:00 that kept the later day — gave it a whole extra
   * day. The date field changing beside the time is what says so.
   */
  let { value = $bindable(), day = $bindable(), label, step = 5 } = $props()

  /** The value an arrow key is rolling from, until its change lands. */
  let rolling = null

  /** Turn `HH:MM` into minutes since midnight, tolerating an empty field. */
  function toMinutes(clock) {
    const [hours, minutes] = (clock || '00:00').split(':').map(Number)
    return hours * 60 + minutes
  }

  /**
   * Nudge the time, carrying the day across midnight when there is one.
   *
   * Without a day — the add panel, whose two times share one date — it is
   * clamped rather than wrapped: rolling 23:55 round to 00:00 there would move
   * the session to a different day without saying so.
   */
  function nudge(direction) {
    if (day) {
      ;({ day, clock: value } = rollClock(day, value, direction * step))
      return
    }
    const minutes = Math.min(24 * 60 - 1, Math.max(0, toMinutes(value) + direction * step))
    value = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
      minutes % 60
    ).padStart(2, '0')}`
  }

  /**
   * Carry the day when an arrow key rolled the time past midnight.
   *
   * One press moves the hour by one, or the minutes round within their hour,
   * so a jump of more than twelve hours can only be a wrap. A *typed* time is
   * never read this way: "23:00" over "00:00" may mean the same day, and the
   * value alone cannot say which.
   */
  function carry(event) {
    const before = rolling
    rolling = null
    if (!day || before === null || !event.currentTarget.value) return
    const moved = toMinutes(event.currentTarget.value) - toMinutes(before)
    if (moved > 12 * 60) day = shiftDay(day, -1)
    else if (moved < -12 * 60) day = shiftDay(day, 1)
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
    onkeydown={(event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') rolling = value
    }}
    oninput={carry}
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
