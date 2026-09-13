<script>
  import { findIcons } from './icons.js'

  /**
   * An icon, chosen rather than typed.
   *
   * The search and the choice are two different things, and the habit form used
   * to make them one field: you typed into the preview, so anything you typed
   * *was* the icon and a habit could be labelled "AAAA". The box takes words,
   * the row takes the choice, and there is no free-text path to the stored
   * value at all — which is the validation, rather than something to reject
   * afterwards.
   *
   * Shared because a task and a step now want the same control for the same
   * reason. The component owns only what somebody has typed into the search;
   * the chosen value belongs to the caller, which is what lets a question hold
   * `''` for "no icon" while a task holds `null`.
   */
  let {
    /** The chosen icon, or a falsy value for none. */
    value = null,
    /** Called with the icon chosen, or `null` when it is cleared. */
    onchange = () => {},
    /** What the preview is labelled. */
    label = 'Icon',
    /**
     * Whether the grid of choices is folded away until it is asked for.
     *
     * Fifty icons always on screen is the largest thing in the task modal, and
     * it is the control least often used there — so a modal opened to change a
     * date is mostly a grid of emoji. Collapsed, the row is the chosen icon and
     * a search box, and the grid appears when the search is focused or has
     * anything in it and folds away again once something is picked.
     *
     * A prop rather than the new behaviour everywhere: the catalogue's question
     * form is a page about one question, where the grid is not competing with
     * anything and its tests describe it as it is. One control, two settings,
     * and the setting is at the call site where the reason for it is.
     */
    collapsed = false,
  } = $props()

  /** What has been typed into the search. Never the stored value. */
  let search = $state('')

  /** Whether the grid has been asked for, when it is not simply always drawn. */
  let open = $state(false)

  /**
   * Whether the choices are on screen.
   *
   * Not closed on `blur`, deliberately: choosing an icon blurs the search box
   * on the way to the button, so a grid that folded away on blur would fold
   * away before the click it was blurred by could land.
   */
  const showing = $derived(!collapsed || open || Boolean(search))

  const matches = $derived(findIcons(search))

  /**
   * Take a choice and put the grid away.
   *
   * @param {string|null} icon The icon chosen, or null to clear it.
   */
  function choose(icon) {
    search = ''
    open = false
    onchange(icon)
  }
</script>

<div class="flex flex-wrap items-end gap-3">
  <div class="flex flex-col gap-1.5">
    <span class="meta">{label}</span>
    {#if collapsed}
      <!-- The preview is the way in as well as the picture, so the grid is one
           tap from the thing it is about. -->
      <button
        type="button"
        data-icon-preview
        aria-expanded={showing}
        aria-label={value ? `Icon ${value}, change it` : 'Choose an icon'}
        class="flex size-12 items-center justify-center rounded-lg border border-white/15
               bg-ink text-2xl transition hover:border-white/40"
        onclick={() => (open = !showing)}
      >
        {#if value}
          {value}
        {:else}
          <span class="meta text-haze">none</span>
        {/if}
      </button>
    {:else}
      <span
        data-icon-preview
        class="flex size-12 items-center justify-center rounded-lg border border-white/15
               bg-ink text-2xl"
      >
        {#if value}
          {value}
        {:else}
          <span class="meta text-haze">none</span>
        {/if}
      </span>
    {/if}
  </div>
  <label class="flex min-w-48 flex-1 flex-col gap-1.5">
    <span class="meta">Find one</span>
    <input
      bind:value={search}
      placeholder="run, water, sleep…"
      aria-label="Find an icon"
      onfocus={() => (open = true)}
      class="rounded-lg border border-white/15 bg-ink px-4 py-3"
    />
  </label>
  {#if value}
    <button
      type="button"
      class="meta rounded-md border border-white/15 px-3 py-3 hover:border-ember"
      onclick={() => choose(null)}
    >
      Clear
    </button>
  {/if}
</div>

{#if showing}
  <!-- Scrolls itself rather than the page: the whole set is fifty icons, and a
       search that matches most of them would otherwise push whatever sits below
       it out of sight. -->
  <div
    data-icon-choices
    class="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border
           border-white/10 p-2"
  >
    {#each matches as match (match.icon)}
      <button
        type="button"
        aria-label={`Use ${match.terms.split(' ')[0]}`}
        aria-pressed={value === match.icon}
        data-icon={match.icon}
        class="rounded-md border px-2 py-1 text-lg transition
               {value === match.icon
          ? 'border-sage bg-sage/15'
          : 'border-white/15 hover:border-white/40'}"
        onclick={() => choose(match.icon)}
      >
        {match.icon}
      </button>
    {:else}
      <span class="meta px-1 py-1 normal-case text-haze">
        Nothing matches “{search}”. Try what the icon is about — run, water, sleep.
      </span>
    {/each}
  </div>
{/if}
