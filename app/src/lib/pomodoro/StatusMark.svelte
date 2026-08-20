<script>
  /**
   * What became of a pomodoro, as one mark you can also press.
   *
   * Four states from two booleans, and the mark *is* the control: pressing it
   * marks the focus tainted or takes the mark back. There used to be a separate
   * Taint button and a word beside it saying "Complete" or "Abandoned", which
   * on a phone was three things competing for a row that also holds a time, a
   * task and two more buttons.
   *
   * | | untainted | tainted |
   * | --- | --- | --- |
   * | complete | green tick | yellow tick |
   * | abandoned | green pause | red cross |
   *
   * A running pomodoro is a fifth thing and not a state you can press: it has
   * not gone well or badly yet, so it shows a ring in the section accent and
   * takes no clicks.
   */

  let { state, tainted = false, onclick } = $props()

  const abandoned = $derived(state === 'abandoned')
  const running = $derived(state === 'running')

  const colour = $derived(
    running ? 'dusk-lift' : !tainted ? 'sage' : abandoned ? 'alarm' : 'amber'
  )

  /** What the mark says, and what pressing it would do — for a screen reader. */
  const meaning = $derived(
    `${abandoned ? 'Abandoned' : 'Complete'}${tainted ? ', tainted' : ''}`
  )
</script>

<button
  type="button"
  class="shrink-0 rounded-md p-1 transition {running ? '' : 'hover:bg-white/10'}"
  disabled={running}
  aria-pressed={running ? undefined : tainted}
  aria-label={running
    ? 'Running'
    : `${meaning}. Press to ${tainted ? 'clear the taint' : 'mark it tainted'}`}
  data-mark={running ? 'running' : abandoned ? (tainted ? 'cross' : 'pause') : 'tick'}
  data-tainted={tainted}
  {onclick}
>
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    style:color="var(--color-{colour})"
  >
    {#if running}
      <circle cx="10" cy="10" r="6" stroke="currentColor" stroke-width="2" />
    {:else if !abandoned}
      <path
        d="M4 10.5l4 4 8-9"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else if !tainted}
      <!-- A pause, not a stop: the focus was interrupted rather than finished,
           which is a different thing from having gone badly. -->
      <path d="M7 4v12M13 4v12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    {:else}
      <path
        d="M5 5l10 10M15 5L5 15"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    {/if}
  </svg>
</button>
