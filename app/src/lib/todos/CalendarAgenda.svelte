<script>
  import { estimateLabel } from '../clock.js'
  import { dayLabel } from '../day.js'
  import { agendaDay } from './agenda.js'
  import { taskColour } from './fields.js'

  /**
   * A phone's Week: the seven days of the strip's week as a list.
   *
   * Seven hour columns do not fit below 48rem, and drawing one under the strip
   * made Week and Day the same picture with arrows that stepped differently. So
   * here Week is a schedule — a heading per day and the tasks planned on it —
   * and the hours stay Day's. A day's heading goes to that day in Day, which is
   * the way to a time.
   *
   * **It is never a scroll box of its own**, on a phone of any height: it is a
   * column, and a column is never its own scroll box on a phone. So the short
   * window's rule holds without a branch, and the drag's auto-scroll moves the
   * window, which it reads off this element's computed overflow.
   *
   * **A row is a block in everything but shape.** The same button opening the
   * task, the same long press and afterglow, the same colour edge and tint, the
   * same `select-none` and callout rule, the same drawing of a done task — so it
   * carries `data-block`, and the drag, the menu and the keyboard find it the
   * way they find a block.
   *
   * **A section is a strip chip, as a drop target.** It carries `data-drop-day`
   * while something is carried, so a drop on it is the chip's drop: the day
   * alone, keeping the time the task had, and nothing written when that is the
   * day it already had. Dropping at a time and resizing an estimate are Day's
   * job — a list has no axis to aim at.
   *
   * Nothing here holds state. The drag and the menu are the calendar's, handed
   * in, because the carried copy and the live region are drawn there for both
   * pictures.
   */
  let {
    /** The seven `YYYY-MM-DD` keys of the week, in order. */
    days = [],
    /** Every live task, of any list and any day. */
    tasks = [],
    /** Today's key, so the list marks it as the strip does. */
    today,
    /** Whether due marks are drawn. */
    showDue = false,
    /** The lists by id, for a row's colour. */
    listsById = {},
    /** The calendar's drag, whose conventions every row starts. */
    drag,
    /** The calendar's task menu, or null where none is offered. */
    menu = null,
    /** This list's element, which the drag auto-scrolls the window against. */
    box = $bindable(null),
    /** Open a task; the caller has already refused a release that was a drop. */
    onopen = () => {},
    onadd = () => {},
    /** Show a day in Day, which is where its hours are. */
    onday = () => {},
    onkey = () => {},
  } = $props()

  const sections = $derived(days.map((day) => ({ day, ...agendaDay(tasks, day, { showDue }) })))

  /** A row's colour, by the precedence a block uses. */
  function colourOf(task) {
    return taskColour(task, listsById[task.list_id])
  }

  /** Whether a carried task is over this day's section. */
  function over(day) {
    return Boolean(drag.dragging && drag.over?.kind === 'chip' && drag.over.day === day)
  }
</script>

<div class="border-t border-white/10" data-agenda bind:this={box}>
  {#each sections as { day, items, due } (day)}
    <!-- No gap between sections, so every pixel of the list is some day's drop
         target and a drop cannot land on nothing between two of them. -->
    <section
      class="border-b border-white/10 px-1 transition
             {over(day) ? 'bg-dusk/30 ring-1 ring-ember ring-inset' : ''}"
      data-agenda-day={day}
      data-drop-day={drag.dragging ? day : undefined}
      data-drop-over={over(day) ? '' : undefined}
    >
      <div class="flex items-stretch gap-1 py-0.5" data-head-day={day}>
        <button
          class="meta flex min-h-11 min-w-0 flex-1 items-center truncate text-left
                 {day === today ? 'text-ember' : ''}"
          data-agenda-heading={day}
          data-today={day === today}
          aria-label={`Open ${dayLabel(day)} in Day`}
          onclick={() => onday(day)}
        >
          {dayLabel(day)}
        </button>
        <button
          class="meta min-h-11 min-w-11 rounded-md border border-white/15 px-3 hover:border-white/40"
          data-add={day}
          aria-label={`Add a task to ${dayLabel(day)}`}
          onclick={() => onadd({ day, hour: null })}
        >
          +
        </button>
      </div>

      {#if !items.length && !due.length}
        <p class="meta pb-2 text-haze" data-agenda-empty>Nothing planned</p>
      {:else}
        <ul class="flex flex-col gap-1 pb-2">
          {#each items as { task, at, minutes, due: outlined } (task.client_id)}
            <li class="relative">
              <button
                class="flex min-h-11 w-full touch-pan-y items-center gap-2 rounded border-l-2 px-2
                       text-left text-sm select-none [-webkit-touch-callout:none] transition
                       hover:brightness-125
                       focus-visible:ring-1 focus-visible:ring-ember focus-visible:outline-none
                       {task.done_at ? 'text-haze line-through opacity-60' : ''}
                       {drag.dragging === task.client_id ? 'opacity-40' : ''}"
                data-block
                data-agenda-item
                data-client-id={task.client_id}
                data-carrying={drag.dragging === task.client_id}
                style:border-color={colourOf(task)}
                style:background={`color-mix(in srgb, ${colourOf(task)} 18%, var(--color-ink))`}
                oncontextmenu={menu ? (event) => menu.contextmenu(event, task) : undefined}
                onpointerdown={(event) => {
                  drag.start(event, task)
                  menu?.press(event, task)
                }}
                onkeydown={(event) => onkey(event, task)}
                onclick={() => onopen(task)}
              >
                <span class="min-w-0 flex-1 truncate">{task.title}</span>
                {#if at}
                  <span class="numeral shrink-0 text-xs text-haze" data-agenda-time>{at}</span>
                  {#if estimateLabel(minutes)}
                    <span class="numeral shrink-0 text-xs text-haze" data-agenda-estimate>
                      {estimateLabel(minutes)}
                    </span>
                  {/if}
                {/if}
              </button>
              {#if outlined}
                <!-- Due on the day it is planned: its own row is outlined, as a
                     mark outlines its own block, rather than listed twice. -->
                <div
                  class="pointer-events-none absolute inset-0 rounded border border-dashed opacity-80"
                  data-due-mark
                  data-client-id={task.client_id}
                  style:border-color={colourOf(task)}
                ></div>
              {/if}
            </li>
          {/each}
          {#each due as task (task.client_id)}
            <!-- Due here and planned elsewhere. Hollow and not interactive, as a
                 mark is: the thing to tap is the task on its planned day. The
                 title is drawn because a list has no line to join the two. -->
            <li
              class="flex min-h-11 items-center gap-2 rounded border border-dashed px-2 text-sm
                     text-haze opacity-80"
              data-due-mark
              data-client-id={task.client_id}
              style:border-color={colourOf(task)}
            >
              <span class="meta shrink-0">Due</span>
              <span class="min-w-0 flex-1 truncate">{task.title}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>
