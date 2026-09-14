<script>
  import { dismissToast, toasts } from './toasts.js'
</script>

<!-- At the top, just under the header, and not at the bottom. The bottom of a
     phone is where the typing happens — a board's quick-add, the keyboard that
     rises under it — so a toast there sat on the box for five seconds after the
     very gesture that raised it. The header height is the offset: 4.5rem clears
     it at every width, and nothing under it is typed into. -->
<div
  class="pointer-events-none fixed inset-x-0 top-[4.5rem] z-50 flex flex-col items-center gap-2
         px-4"
  data-toasts
>
  {#each $toasts as toast (toast.id)}
    <button
      data-toast={toast.tone ?? 'error'}
      class="pointer-events-auto max-w-md rounded-lg border border-ember/40 bg-ink-soft px-4 py-3
             text-left text-sm text-paper shadow-lg"
      onclick={() => dismissToast(toast.id)}
    >
      {toast.message}
    </button>
  {/each}
</div>
