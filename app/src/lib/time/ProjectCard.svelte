<script>
  import { fade } from 'svelte/transition'

  import { clockLabel, formatDuration, secondsPart } from './duration.js'

  /**
   * One project as a check-in control.
   *
   * Built on the answer band's grammar: a full-bleed card, one tap, and a lit
   * state that is unmistakable from across the room. Where a band shows the
   * value chosen, this shows the time run — the same place in the same shape,
   * so the two halves of the app record things the same way.
   *
   * The whole card is the primary target, so it is an overlay button with the
   * content sitting above it and passing clicks through. A `<button>` cannot
   * contain a `<button>`, and Resume has to be a real one.
   */
  let {
    project,
    running = null,
    seconds = 0,
    resumable = null,
    ontoggle,
    onresume,
    disabled = false,
  } = $props()

  const live = $derived(running !== null)

  /**
   * Whether Resume is asking to be confirmed.
   *
   * Resuming rewrites a stored end time and swallows everything since, so it
   * is the one action here that cannot be undone by tapping again. The card
   * says what it is about to absorb and waits.
   */
  let confirming = $state(false)

  $effect(() => {
    // A card that starts running, or loses its resumable session, must not
    // keep a stale question on it.
    if (live || !resumable) confirming = false
  })

  /**
   * How long the card takes to change state, in milliseconds.
   *
   * The colours, the ring and the swapped-in timer all use it, so a tap reads
   * as one movement. They used to disagree: the text swapped on the same frame
   * as the click while the colours took 150ms to catch up, which is what made
   * the change feel like a jolt followed by a fade.
   */
  const SETTLE = 150

  /** How long the session Resume would reopen already ran. */
  const resumableLength = $derived(
    resumable
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(`${resumable.ended_at}Z`) -
              Date.parse(`${resumable.started_at}Z`)) /
              1000
          )
        )
      : 0
  )
</script>

<div
  data-project={project.id}
  data-running={live ? 'yes' : 'no'}
  style:transition-duration="{SETTLE}ms"
  class="group relative flex min-h-20 w-full flex-wrap items-center justify-between gap-x-4
         gap-y-2 overflow-hidden rounded-lg border px-5 py-4 text-left transition ease-out
         {live
    ? 'border-ember bg-dusk/30 ring-2 ring-ember/60'
    : 'border-white/10 bg-ink-soft hover:border-white/30 hover:bg-dusk/10'}"
>
  <!-- The hover lift is a colour, not a `brightness` filter: the filter was
       still at 1.25 under the cursor at the moment of the click, so turning a
       card on made it visibly *darken* as the hover state fell away — a change
       fighting the one being asked for. -->
  <button
    type="button"
    aria-pressed={live}
    aria-label="{live ? 'Stop' : 'Start'} {project.name}"
    onclick={() => ontoggle(project, running)}
    class="absolute inset-0 z-0"
  ></button>

  <!-- The project's own colour as a leading edge: the one thing that stays put
       whether the card is lit, listed elsewhere, or drawn in a chart. -->
  <span
    class="pointer-events-none absolute inset-y-0 left-0 z-10 w-1.5"
    style:background="var(--color-{project.colour}, var(--color-dusk-lift))"
  ></span>

  <!-- The name gets the whole width it needs; a long one pushes the timer onto
       its own line rather than being clipped to three letters on a phone. -->
  <span class="pointer-events-none relative z-10 ml-2 min-w-0 flex-1 basis-40">
    <span class="block truncate text-lg font-semibold">{project.name}</span>
    <span class="meta mt-1 block truncate normal-case">
      <!-- The elapsed time answers "how long"; this answers "since when",
           which is what you need to judge whether it was left running. -->
      {#if live}
        since {clockLabel(running.started_at, running.utc_offset)}
      {/if}
      {#if live && project.tags.length}·{/if}
      {#if project.tags.length}
        <!-- The icon is what separates "Client work" the tag from "since 09:00"
             the clause: joined by dots alone, the line read as one sentence
             whose second half happened to be nouns. -->
        <svg
          viewBox="0 0 16 16"
          width="11"
          height="11"
          fill="none"
          aria-hidden="true"
          class="mr-0.5 inline-block align-baseline"
        >
          <path
            d="M2.2 2.2h5L14 9l-5 5-6.8-6.8V2.2Z"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
          <circle cx="5" cy="5" r="1.1" fill="currentColor" />
        </svg>
        {project.tags.map((tag) => tag.name).join(' · ')}
      {/if}
    </span>
  </span>

  <!-- Inert, like the rest of the content: clicks belong to the overlay button
       underneath. Only Resume takes its events back. -->
  <span class="pointer-events-none relative z-10 ml-auto flex shrink-0 items-center gap-3">
    {#if live}
      <!-- Minutes carry the reading; the seconds are there to move, so a tap is
           visibly a running timer rather than a state that might not have taken.
           Kept smaller and dimmer so the ticking does not pull the eye off the
           number that actually matters, and tabular so nothing reflows. -->
      <span
        in:fade={{ duration: SETTLE }}
        class="numeral pointer-events-none flex items-baseline gap-1 text-2xl text-paper
               tabular-nums md:text-3xl"
      >
        {formatDuration(seconds)}
        <span class="text-base text-haze md:text-lg" data-seconds>
          {secondsPart(seconds)}
        </span>
      </span>
      <span
        in:fade={{ duration: SETTLE }}
        class="meta pointer-events-none rounded-md border border-ember/60 px-3 py-2 text-paper"
      >
        Stop
      </span>
    {:else}
      {#if confirming}
        <span in:fade={{ duration: SETTLE }} class="meta normal-case">
          Reopen {formatDuration(resumableLength)}, stopped {clockLabel(
            resumable.ended_at,
            resumable.utc_offset
          )}?
        </span>
        <button
          type="button"
          data-resume-confirm
          {disabled}
          onclick={() => onresume(project)}
          class="meta pointer-events-auto rounded-md border border-ember px-3 py-2
                 text-paper hover:bg-ember/10"
        >
          Resume
        </button>
        <button
          type="button"
          class="meta pointer-events-auto rounded-md border border-white/20 px-3 py-2
                 hover:border-white/40"
          onclick={() => (confirming = false)}
        >
          Cancel
        </button>
      {:else}
        {#if resumable}
          <!-- The only control on the card that is not the card: a stop by
               mistake is undone here, and the pause since counts as worked.
               Hovers white like every other outlined control — it opens a
               confirmation rather than doing anything, and the ember hover is
               how the app says "careful", which belongs on the button that
               actually rewrites the session. -->
          <button
            type="button"
            data-resume
            {disabled}
            onclick={() => (confirming = true)}
            class="meta pointer-events-auto rounded-md border border-white/20 px-3 py-2
                   hover:border-white/40"
          >
            Resume
          </button>
        {/if}
        <span
          in:fade={{ duration: SETTLE }}
          class="meta pointer-events-none rounded-md border border-white/20 px-3 py-2
                 group-hover:border-white/40"
        >
          Start
        </span>
      {/if}
    {/if}
  </span>
</div>
