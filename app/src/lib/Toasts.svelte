<script>
  import { dismissToast, toasts } from './toasts.js'
</script>

<div class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4">
  {#each $toasts as toast (toast.id)}
    <button
      class="pointer-events-auto max-w-md rounded-lg border border-ember/40 bg-ink-soft px-4 py-3
             text-left text-sm text-paper shadow-lg"
      onclick={() => dismissToast(toast.id)}
    >
      {toast.message}
    </button>
  {/each}
</div>
