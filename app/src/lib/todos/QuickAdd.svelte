<script>
  import { chipColour } from '../palette.js'
  import { FIELD_COLOURS, newTaskFields, presetSummary } from './fields.js'
  import { parse } from './parse.js'

  /**
   * The box at the foot of a column, where a task is typed rather than built.
   *
   * Two layers, one string. An `<input>` cannot colour parts of its own value,
   * and the two ways round that are `contenteditable` — which means owning IME
   * composition, paste, mobile keyboards and caret restoration — or this: the
   * real input in front with transparent text, and a `<div>` behind it drawing
   * the same characters as coloured spans. You type into a browser text field
   * and see the layer behind it through it, so the caret, the selection,
   * autocorrect and paste are all still the browser's.
   *
   * **The two layers share every metric through one class**, `METRICS` below.
   * Font, size, weight, letter-spacing, padding, border width, line height and
   * `white-space: pre` are set once and applied to both. A single pixel of
   * disagreement and the colouring drifts from the text by the end of a line,
   * which is why the alignment is measured by a test rather than eyeballed.
   *
   * Single line, deliberately: wrapping makes the alignment far harder and buys
   * nothing here, and the modal's own title field does not parse at all —
   * editing a field explicitly is not the same gesture as typing a task.
   */
  let {
    column,
    today,
    lists = [],
    /**
     * The list a task typed here is created into, or null to say nothing about
     * it. Set only where more than one list is on screen, which is where the
     * answer could surprise somebody.
     */
    into = null,
    onadd = () => {},
  } = $props()

  /**
   * Every metric both layers must agree on, as one literal string.
   *
   * Literal because Tailwind's scanner only sees text that is written out: a
   * class assembled at runtime compiles to no CSS at all.
   *
   * The border's *colour* is deliberately not in here — only its width is
   * layout. Each layer names its own, so the two never compile two
   * `border-color` declarations that fight over which came later in the sheet.
   */
  const METRICS =
    'w-full rounded-lg border px-3 py-2 text-sm font-normal leading-5 ' +
    'tracking-normal whitespace-pre'

  let text = $state('')
  let box
  let overlay

  /**
   * Matches the person has clicked back into plain text, as `(field, text)`
   * pairs.
   *
   * A pair rather than an offset, which is what makes it predictable in both
   * directions: dismissing *tomorrow* leaves that word plain however the rest
   * of the line is edited afterwards, typing `friday` instead is recognised
   * because it is a different match, and typing `tomorrow` back is not because
   * it is the same one.
   */
  let dismissed = $state([])

  const parsed = $derived(parse(text, { today, lists, dismissed }))

  /**
   * The string as runs, plain and recognised, in order.
   *
   * Built from the tokens' own offsets rather than by searching the text again:
   * the parser reports exactly which characters it consumed, and a second
   * search would find a different `tomorrow`.
   */
  const runs = $derived.by(() => {
    const out = []
    let at = 0
    for (const token of parsed.tokens) {
      if (token.start > at) out.push({ text: text.slice(at, token.start), field: null })
      out.push({ text: token.text, field: token.field })
      at = token.end
    }
    if (at < text.length) out.push({ text: text.slice(at), field: null })
    return out
  })

  /**
   * What Enter will set, and what Enter actually writes — one object.
   *
   * Handed to `onadd` rather than recomposed by the caller, so the line under
   * the box and the task that is created cannot disagree. `newTaskFields` is
   * also where `planned_on` falls back to today, which is why a quadrant's
   * preset line reads *today · high · due in three days* rather than leaving
   * the day to a default nothing on screen mentions.
   */
  const fields = $derived(newTaskFields(column, parsed.patch, today, into))

  const summary = $derived(presetSummary(fields, today, lists))

  /**
   * The colour a `#list` run is drawn in, which is the list's own.
   *
   * Data rather than a token this app chose, so it is an inline `var()` and not
   * a class: a colour built into a class name at runtime compiles to nothing.
   *
   * And because it is data, **colour alone cannot say that a run is a list**.
   * Measured: `!1` draws `rgb(217, 163, 60)` and a list coloured *amber* draws
   * `rgb(217, 163, 60)` — the same pixels. Moving the priority token to a spare
   * hue would fix that one pair and leave four, since five of the six colours a
   * list can carry (iris, amber, rose, sage, haze) are also field colours. So
   * the list run carries a dotted underline no other run has, which is a
   * treatment rather than a hue and holds however the palette moves. A
   * decoration changes no metric, so the two layers stay aligned.
   *
   * @param {string|null} field The run's field.
   * @returns {string|undefined} A CSS colour, or nothing for any other run.
   */
  function listColour(field) {
    if (field !== 'list_id') return undefined
    const list = lists.find((one) => one.id === parsed.patch.list_id)
    return chipColour(list?.colour, 'paper')
  }

  /**
   * Dismiss the coloured run the caret landed in.
   *
   * The overlay is *behind* the input and keeps `pointer-events: none`, so it
   * can never be clicked; the click lands on the input and `selectionStart`
   * says which token it fell inside. That is the whole hit test.
   *
   * Strictly inside, and that is not fussiness: clicking past the end of the
   * text to carry on typing puts the caret exactly at the last token's end, so
   * an inclusive test would dismiss a match every time somebody resumed typing.
   */
  function onClick() {
    if (!box || box.selectionStart !== box.selectionEnd) return
    const at = box.selectionStart
    const hit = parsed.tokens.find((token) => at > token.start && at < token.end)
    if (!hit) return
    dismissed = [...dismissed, { field: hit.field, text: hit.text }]
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      // One key means "never mind" everywhere in this app — and it takes the
      // dismissals with it, since they describe a line that no longer exists.
      event.preventDefault()
      text = ''
      dismissed = []
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    // **Read out of the derived before the box is cleared.** `$derived` is
    // lazy, so `parsed.patch` read after `text = ''` is the parse of an empty
    // string — every recognised field silently lost, and the task created with
    // the column's preset alone. Which is how this first shipped, and what
    // `#errands names a list that exists` caught.
    const { title } = parsed
    // Read out of the derived before the box is cleared, for the same reason
    // the title is: `$derived` is lazy, so `fields` read after `text = ''` is
    // the parse of an empty string with the column's preset over it.
    const wanted = fields
    const named = title.trim()
    if (!named) return
    // Cleared before the write rather than after it: the write is queued on the
    // device and does not wait for a server, so there is nothing to wait for
    // here either — and a box that empties on the next keystroke instead of on
    // Enter is a box that eats a fast second task.
    text = ''
    dismissed = []
    onadd(named, wanted, column)
    box?.focus()
  }
</script>

<div class="flex flex-col gap-1">
  <div class="relative">
    <!-- The picture of the string, behind. `aria-hidden` and
         `pointer-events-none`: it is not content and it is not a target, and a
         screen reader hearing the line twice would be worse than hearing it
         without its colours. Its own horizontal scroll follows the input's, or
         a line longer than the box would colour the wrong characters. -->
    <div
      bind:this={overlay}
      data-quick-add-overlay={column.id}
      aria-hidden="true"
      class="{METRICS} pointer-events-none absolute inset-0 overflow-hidden
             border-transparent text-paper"
    >
      <!-- Written with no whitespace of its own anywhere inside the loop. A
           newline in the template is a text node in the output, and one space
           between two runs would shift every character after it — which is the
           same failure as a padding disagreement, arriving from the markup
           instead of from the class. -->
      {#each runs as run, at (at)}<span
          data-token={run.field ?? undefined}
          class="{run.field ? (FIELD_COLOURS[run.field] ?? '') : ''} {run.field === 'list_id'
            ? 'underline decoration-dotted underline-offset-2'
            : ''}"
          style:color={listColour(run.field)}
        >{run.text}</span>{/each}
    </div>

    <!-- In front, and transparent apart from its caret. Everything a text field
         does for free — IME, autocorrect, paste, selection, the caret — still
         happens, because none of it was replaced. -->
    <input
      bind:this={box}
      bind:value={text}
      data-quick-add={column.id}
      type="text"
      autocomplete="off"
      placeholder={`Add to ${column.label.toLowerCase()}…`}
      aria-label={`Add a task to ${column.label}`}
      class="{METRICS} relative border-white/10 bg-transparent text-transparent
             caret-paper placeholder:text-haze/60 hover:border-white/30
             focus:border-dusk-lift focus:outline-none"
      onkeydown={onKey}
      onclick={onClick}
      onscroll={() => {
        if (overlay && box) overlay.scrollLeft = box.scrollLeft
      }}
    />
  </div>

  <!-- What Enter will do, before it does it. The column's own preset is in here
       as well as the parsed fields, because a preset nothing on screen mentions
       is the smoothing-slider trap in miniature. -->
  {#if summary.length}
    <p class="meta pl-3" data-quick-add-preset={column.id}>{summary.join(' · ')}</p>
  {/if}
</div>
