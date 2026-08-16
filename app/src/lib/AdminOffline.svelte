<script module>
  /**
   * What a control says for itself when the connection is why it is dead.
   *
   * The notice below explains a whole page at once; this is for the pointer
   * that arrives at one button having scrolled past it. Deliberately the same
   * sentence everywhere — a control that explains itself differently from the
   * one beside it reads as a different kind of refusal.
   */
  export const OFFLINE_HINT = 'Not available without a connection'
</script>

<script>
  import { connection } from './sync.js'

  /**
   * Why every control on an administrative page has gone quiet.
   *
   * These pages change the account itself — its projects, its questions, its
   * people — and none of it goes through the queue: there is no sensible merge
   * for "renamed a catalogue here while it was deleted there", so the app does
   * not pretend to offer one. The controls are therefore disabled rather than
   * left to fail on a tap, and this says why once instead of on each of them.
   *
   * Paired with `disabled` on the controls themselves, not a substitute for it.
   * A notice above a page of live-looking buttons is a notice nobody reads
   * until after they have pressed one.
   */
  let { does = 'Everything on this page changes the account itself' } = $props()
</script>

{#if $connection !== 'online'}
  <p
    data-admin-offline
    class="mb-6 rounded-lg border border-white/15 bg-ink-soft px-4 py-3 text-sm text-haze"
  >
    {does}. Changes here need a connection; tracking and answering do not.
  </p>
{/if}
