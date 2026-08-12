<script>
  import { formatDuration, secondsPart } from './duration.js'

  /**
   * One project as a check-in control.
   *
   * Built on the answer band's grammar: a full-bleed card, one tap, and a lit
   * state that is unmistakable from across the room. Where a band shows the
   * value chosen, this shows the time run — the same place in the same shape,
   * so the two halves of the app record things the same way.
   */
  let { project, running = null, seconds = 0, ontoggle, disabled = false } = $props()

  const live = $derived(running !== null)
</script>

<button
  type="button"
  data-project={project.id}
  data-running={live ? 'yes' : 'no'}
  {disabled}
  aria-pressed={live}
  onclick={() => ontoggle(project, running)}
  class="group relative flex min-h-20 w-full flex-wrap items-center justify-between gap-x-4
         gap-y-2 overflow-hidden rounded-lg border px-5 py-4 text-left transition duration-150
         ease-out
         disabled:cursor-not-allowed disabled:opacity-40
         {live
    ? 'border-ember bg-dusk/30 ring-2 ring-ember/60'
    : 'border-white/10 bg-ink-soft hover:border-white/30 hover:brightness-125'}"
>
  <!-- The project's own colour as a leading edge: the one thing that stays put
       whether the card is lit, listed elsewhere, or drawn in a chart. -->
  <span
    class="absolute inset-y-0 left-0 w-1.5"
    style:background="var(--color-{project.colour}, var(--color-dusk-lift))"
  ></span>

  <!-- The name gets the whole width it needs; a long one pushes the timer onto
       its own line rather than being clipped to three letters on a phone. -->
  <span class="ml-2 min-w-0 flex-1 basis-40">
    <span class="block truncate text-lg font-semibold">{project.name}</span>
    {#if project.tags.length}
      <span class="meta mt-1 block truncate normal-case">
        {project.tags.map((tag) => tag.name).join(' · ')}
      </span>
    {/if}
  </span>

  <span class="ml-auto flex shrink-0 items-center gap-4">
    {#if live}
      <!-- Minutes carry the reading; the seconds are there to move, so a tap is
           visibly a running timer rather than a state that might not have taken.
           Kept smaller and dimmer so the ticking does not pull the eye off the
           number that actually matters, and tabular so nothing reflows. -->
      <span class="numeral flex items-baseline gap-1 text-2xl text-paper tabular-nums md:text-3xl">
        {formatDuration(seconds)}
        <span class="text-base text-haze md:text-lg" data-seconds>
          {secondsPart(seconds)}
        </span>
      </span>
      <span class="meta rounded-md border border-ember/60 px-3 py-2 text-paper">Stop</span>
    {:else}
      <span class="meta rounded-md border border-white/20 px-3 py-2 group-hover:border-white/50">
        Start
      </span>
    {/if}
  </span>
</button>
