<script>
  /**
   * A pencil, for editing something in place.
   *
   * Decorative only — the button around it carries the accessible name, via
   * `aria-label`, the same way the arrow and × glyphs already used for the
   * move and remove-band controls do not need one of their own.
   */
  let { class: className = 'size-4' } = $props()
</script>

<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class={className}>
  <path
    d="M11.1 2.1a1.6 1.6 0 0 1 2.3 0l.5.5a1.6 1.6 0 0 1 0 2.3l-7.6 7.6-3.2.8.8-3.2 7.2-7Z"
    stroke="currentColor"
    stroke-width="1.3"
    stroke-linejoin="round"
  />
  <path d="M9.6 3.6 12.4 6.4" stroke="currentColor" stroke-width="1.3" />
</svg>
