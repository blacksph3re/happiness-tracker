<script>
  import { formatDuration } from '../../lib/clock.js'
  import {
    ensureProjects,
    projects as projectStore,
    transferDay,
  } from '../../lib/store.js'
  import { pushToast } from '../../lib/toasts.js'

  /**
   * The one place this half touches the other.
   *
   * It copies; it does not link. Nothing records which session a pomodoro
   * became, so correcting a pomodoro afterwards cannot reach it — which is the
   * whole reason there is no synchronisation to keep, and the reason the
   * sentence below says so out loud rather than leaving it to be discovered.
   *
   * The figure on the button is the day's total, passed straight in. It used to
   * be read back from the server, which cost a round trip and — while the two
   * were computed from different rules — let the button and the totals above it
   * show different numbers on one screen. Now they cannot: it is the same value.
   */

  let { day, seconds, pending = 0 } = $props()

  let open = $state(false)
  let chosen = $state(null)
  let busy = $state(false)

  const options = $derived(($projectStore ?? []).filter((project) => project.active))

  $effect(() => {
    ensureProjects()
  })

  async function confirm() {
    if (!chosen) return
    busy = true
    try {
      const written = await transferDay(day, chosen)
      pushToast(`Copied ${formatDuration(written.seconds)} to a project.`, 'success')
      open = false
      chosen = null
    } catch (failure) {
      // The commonest refusal by far is an overlap: the project was tracked by
      // hand as well as focused on. Saying which is more use than "failed".
      pushToast(failure?.detail ?? 'That could not be copied.')
    } finally {
      busy = false
    }
  }
</script>

{#if seconds > 0 || pending > 0}
  <div class="mt-6 rounded-xl border border-white/10 bg-ink-soft p-5" data-transfer>
    <!-- No sentence restating the day's total: it is three lines above, and
         while the two were computed differently they disagreed. -->
    {#if seconds <= 0}
      <p class="meta normal-case text-haze" data-pending-note>
        The running pomodoro is not finished, so there is nothing to copy yet.
      </p>
    {:else if open}
      <div class="mt-4 flex flex-wrap items-center gap-2">
        {#each options as project (project.id)}
          <button
            class="meta rounded-md border px-3 py-2 transition
                   {chosen === project.id
                     ? 'border-white/60 bg-dusk/20'
                     : 'border-white/15 hover:border-white/40'}"
            aria-pressed={chosen === project.id}
            onclick={() => (chosen = project.id)}
          >
            {project.name}
          </button>
        {/each}
        {#if options.length === 0}
          <p class="text-haze">No projects to copy it to yet.</p>
        {/if}
      </div>
      <div class="mt-4 flex items-center gap-3">
        <button
          data-confirm-transfer
          class="rounded-md bg-dusk px-4 py-2 font-semibold transition
                 hover:bg-dusk-lift disabled:opacity-40"
          disabled={!chosen || busy}
          onclick={confirm}
        >
          Copy it
        </button>
        <button class="meta hover:text-paper" onclick={() => (open = false)}>Cancel</button>
      </div>
      <p class="meta mt-3 text-haze">
        A copy, not a link — correct it afterwards in Time, not here.
      </p>
    {:else}
      <button
        data-open-transfer
        class="meta rounded-md border border-white/20 px-4 py-2 transition
               hover:border-white/40"
        onclick={() => (open = true)}
      >
        Copy {formatDuration(seconds)} to a project →
      </button>
      {#if pending > 0}
        <!-- Labelled rather than folded in: a running pomodoro has no final
             duration, so the server will not copy it, and a button offering
             time it cannot write would be the two numbers disagreeing again. -->
        <p class="meta mt-2 normal-case text-haze" data-pending-note>
          The running pomodoro is not finished, so its
          {formatDuration(pending)} is not included.
        </p>
      {/if}
    {/if}
  </div>
{/if}
