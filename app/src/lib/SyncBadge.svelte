<script>
  import {
    conflicts,
    connection,
    dismissConflicts,
    flush,
    notices,
    pending,
    syncState,
  } from './sync.js'

  /**
   * A cloud beside the mark, saying where this device's writes are.
   *
   * The one thing it must never do is stay quiet while a queue grows. Silent
   * accumulation is the failure mode of every offline app: the phone looks
   * normal, the laptop shows none of it, and the answers are discovered missing
   * weeks later.
   *
   * Deliberately not a status page. Five states, one line each, and a panel
   * only for the case that needs a person.
   */

  let open = $state(false)

  let panel = $state(null)

  /**
   * Close on anything that means "not this".
   *
   * A panel with no way out but the one control that opened it is a panel
   * people end up reloading the page to be rid of. Anywhere else, and Escape,
   * both close it — the badge's own click keeps toggling, because that is what
   * a reader tries first.
   */
  $effect(() => {
    if (!open) return
    const away = (event) => {
      if (!panel?.contains(event.target)) open = false
    }
    const escape = (event) => {
      if (event.key === 'Escape') open = false
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', escape)
    }
  })

  const LOOK = {
    synced: { label: 'Everything is on the server', tone: 'text-haze' },
    pending: { label: 'waiting to sync', tone: 'text-paper' },
    offline: { label: 'offline — kept on this device', tone: 'text-paper' },
    blocked: { label: 'the server refused this device', tone: 'text-ember' },
    conflicts: { label: 'needs a look', tone: 'text-ember' },
  }

  const look = $derived(LOOK[$syncState])
  const slashed = $derived($syncState === 'offline' || $syncState === 'blocked')

  // Read out as a sentence rather than as an icon and a number beside it: a
  // screen reader hearing "cloud, 3" is not being told the writes are local.
  const spoken = $derived(
    $syncState === 'pending'
      ? `${$pending} ${$pending === 1 ? 'change' : 'changes'} waiting to sync`
      : $syncState === 'conflicts'
        ? `${$conflicts.length} changes need a look`
        : look.label
  )
</script>

<!-- Inside the link to the landing page, so it cannot be a button. A span with
     a click handler would be the a11y problem the app avoids elsewhere; this
     opens on the parent's own navigation being suppressed instead. -->
<span
  class="relative inline-flex items-center {look.tone}"
  data-sync={$syncState}
  data-pending={$pending}
  role="status"
  aria-live="polite"
  aria-label={spoken}
  title={spoken}
  onpointerdown={(event) => event.stopPropagation()}
  onclick={(event) => {
    event.preventDefault()
    event.stopPropagation()
    open = !open
    if (!open) return
    flush()
  }}
>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M7.5 19a4.5 4.5 0 0 1-.5-8.97 6 6 0 0 1 11.6 1.02A3.75 3.75 0 0 1 18 19H7.5Z"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
    {#if slashed}
      <path d="M4 20 20 4" stroke="currentColor" stroke-width="1.6" />
    {:else if $syncState === 'pending'}
      <circle cx="12" cy="14.5" r="2" fill="currentColor" />
    {/if}
  </svg>
  {#if $syncState === 'pending' && $pending > 0}
    <span class="numeral ml-1 text-xs tabular-nums">{$pending}</span>
  {/if}
  {#if $syncState === 'conflicts'}
    <span class="numeral ml-1 text-xs tabular-nums">{$conflicts.length}</span>
  {/if}
</span>

{#if open}
  <!-- Anchored to the header rather than to the badge: at 320px a panel hung
       off an 18px icon is either off-screen or squeezed into nothing. -->
  <div
    bind:this={panel}
    data-sync-panel
    class="absolute top-16 left-4 z-50 w-80 rounded-xl border border-white/15
           bg-ink-soft p-4 shadow-xl"
  >
    <p class="meta">{spoken}</p>

    {#if $connection === 'blocked'}
      <p class="mt-2 text-sm text-haze">
        Signing in again is what fixes this. Nothing on this device is lost by
        doing so — the queue is kept and sent once the server knows you again.
      </p>
    {:else if $syncState === 'offline'}
      <p class="mt-2 text-sm text-haze">
        Everything recorded here is safe on this device and goes up by itself
        when there is a connection.
      </p>
    {/if}

    <button
      class="meta absolute top-3 right-3 rounded-md px-2 py-1 hover:text-paper"
      aria-label="Close"
      onclick={() => (open = false)}
    >
      ×
    </button>

    {#if $conflicts.length || $notices.length}
      <ul class="mt-3 flex flex-col gap-2" data-sync-notices>
        {#each $conflicts as conflict (conflict.seq)}
          <li class="rounded-lg border border-ember/40 px-3 py-2 text-sm">
            {conflict.detail ?? 'The server could not accept this change'}
          </li>
        {/each}
        <!-- Decided rather than refused: these needed no one's attention at the
             time, and are here so that a change nobody asked for out loud is
             still something they can find. -->
        {#each $notices as notice (notice.seq)}
          <li class="rounded-lg border border-white/15 px-3 py-2 text-sm text-haze">
            {notice.detail}
          </li>
        {/each}
      </ul>
      <button
        class="meta mt-3 rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={() => dismissConflicts()}
      >
        Dismiss
      </button>
    {/if}
  </div>
{/if}
