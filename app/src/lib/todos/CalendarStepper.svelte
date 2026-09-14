<script>
  import { dayLabel, shiftDay } from '../day.js'
  import { weekLabel } from './calendar.js'

  /**
   * The calendar's stepper: the arrows, the span they step, and Today.
   *
   * **Navigation, and so drawn in the half's column, never with the grid.** It
   * used to sit above the grid inside the calendar body, which the route hands
   * to `Frame` as its `board`, so it travelled with the grid: a Week spreads
   * across the frame, and the arrows jumped 376px under the Day/Week pills at
   * 1920 every time the mode switched. The day strip stays with the grid, since
   * in Week each chip is the header cell of its own column.
   */
  let {
    /** @type {'day' | 'week'} */
    mode = 'week',
    /** The day the strip has selected, which the label names or sits in. */
    selected,
    /** Today, `YYYY-MM-DD`. */
    today,
    /** Select another day. */
    onselect,
  } = $props()

  /**
   * Step by what the controls name: a day in Day, a whole week in Week.
   *
   * Day used to name a week and step one, which jumped past six days nobody
   * could see. The *mode* decides and not the width: a phone in Week draws a
   * list rather than columns, but the strip and the label above it are a week.
   */
  function step(direction) {
    onselect(shiftDay(selected, direction * (mode === 'day' ? 1 : 7)))
  }
</script>

<!-- Each group is its own flex container, so a cramped row moves a group to the
     next line rather than splitting one in half. The label is where the month is
     said: the chips carry a weekday and a number and no month at all, which at
     320px is the only way seven of them fit. In Day it names the day, because
     that is what the arrows step. -->
<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
  <div class="flex items-center gap-1">
    <button
      class="btn-outline meta min-w-11"
      data-step="-1"
      aria-label={mode === 'day' ? 'Previous day' : 'Previous week'}
      onclick={() => step(-1)}
    >
      ‹
    </button>
    <span
      class="meta min-w-28 text-center whitespace-nowrap"
      data-span-label={mode}
      data-week-label={mode === 'week' ? '' : undefined}
    >
      {mode === 'day' ? dayLabel(selected) : weekLabel(selected)}
    </span>
    <button
      class="btn-outline meta min-w-11"
      data-step="1"
      aria-label={mode === 'day' ? 'Next day' : 'Next week'}
      onclick={() => step(1)}
    >
      ›
    </button>
  </div>

  <button
    class="btn-outline meta"
    data-today-button
    onclick={() => onselect(today)}
  >
    Today
  </button>
</div>
