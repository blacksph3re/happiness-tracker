<script>
  import { parseCsv } from '../csv.js'
  import { saveEntries } from '../store.js'
  import { settle } from '../sync.js'
  import { formatDuration, offsetLabel, utcOffset } from '../clock.js'
  import { crossesClockChange, guessColumns, planImport } from './import.js'

  /**
   * Bringing a project's history in from a spreadsheet.
   *
   * Four steps in the order the decisions have to be made: the file, what its
   * columns mean, which clock its times are on, and — before anything is
   * written — what would happen to every row. That last screen is the whole
   * safeguard, because an import has no undo and nothing in the schema
   * remembers which import a session came from.
   *
   * A panel rather than a modal, matching how Edit and Rule already open on
   * this page. Nothing here needs to trap focus or cover the page, and the
   * project it belongs to stays visible above it.
   */
  let { project, existing = [], onclose } = $props()

  /** Which of the four screens is showing. */
  let step = $state('file')

  /** The file as parsed: its header, its rows, and the separator it used. */
  let file = $state(null)

  /** File name, kept for the heading after the input is gone. */
  let filename = $state('')

  /** Why the file could not be read at all, as opposed to a row that cannot. */
  let refused = $state('')

  /** Which column feeds which field. */
  let mapping = $state({ date: null, start: null, end: null, duration: null, note: null })

  /** The clock the file's times are on, where the values do not say. */
  let offset = $state(utcOffset())

  /** What to do about rows landing on minutes the project already has. */
  let onOverlap = $state('skip')

  /** How many sessions have been written so far, while writing. */
  let written = $state(0)

  /** How many the write set out to make, fixed at the moment it started. */
  let total = $state(0)

  /** What became of the import, once it is over. */
  let outcome = $state(null)

  const columns = $derived(file?.columns ?? [])
  const ready = $derived(Boolean(mapping.start) && Boolean(mapping.end || mapping.duration))

  /**
   * Every row read, and what would happen to it.
   *
   * Recomputed whenever an answer changes, which is why the overlap check is a
   * sweep rather than a comparison of every pair.
   */
  const plan = $derived.by(() => {
    if (!file || !ready) return { sessions: [], days: [], counts: {} }
    return planImport({
      rows: file.rows,
      columns: file.columns,
      mapping,
      offset,
      existing,
    })
  })

  /** Rows that would be written, given the answer to the overlaps. */
  const writing = $derived(
    plan.sessions.filter(
      (one) => one.status === 'ready' || (onOverlap === 'merge' && one.status !== 'unreadable')
    )
  )

  /** Whether any value carried its own offset, which the file's answer cannot override. */
  const dated = $derived(plan.sessions.some((one) => one.status !== 'unreadable' && one.offsetFromFile))

  const warnsAboutClock = $derived(plan.days.length > 1 && crossesClockChange(plan.days))

  /** The offsets worth offering, on the half hour, named. */
  const OFFSETS = Array.from({ length: 53 }, (_, at) => (at - 24) * 30)

  async function read(event) {
    const chosen = event.currentTarget.files?.[0]
    if (!chosen) return
    refused = ''
    filename = chosen.name
    const parsed = parseCsv(await chosen.text())
    if (parsed.columns.length === 0 || parsed.rows.length === 0) {
      refused = 'That file has no rows under a header.'
      file = null
      return
    }
    file = parsed
    mapping = guessColumns(parsed.columns)
    step = 'mapping'
  }

  async function write() {
    step = 'writing'
    written = 0
    // Read once, and the loop below must never read `writing` again. It is
    // derived from what the project holds, and the first chunk changes that:
    // those rows become sessions this project already has, the preview
    // reclassifies them as overlaps, and the list shrinks under the loop. Every
    // row past the first chunk was skipped — silently, and only in a file long
    // enough to have a second one.
    const queue = [...writing]
    total = queue.length
    // How many of them will land on minutes that are already spoken for. The
    // server joins each of those into what is there, so the count of rows sent
    // is not a count of sessions gained, and saying "12 sessions added" when
    // four of them widened an existing one would be the app inventing data
    // about itself.
    const merging = queue.filter((one) => one.status !== 'ready').length

    // In chunks, so the progress is a count of sessions that are actually on
    // the device rather than an animation, and so a file of thousands does not
    // arrive as one request the server has to hold in memory whole.
    const CHUNK = 100
    let sent = true
    for (let at = 0; at < queue.length; at += CHUNK) {
      const batch = queue.slice(at, at + CHUNK)
      const stored = await saveEntries(
        batch.map((one) => ({
          project_id: project.id,
          started_at: one.startedAt,
          ended_at: one.endedAt,
          utc_offset: one.offset,
          note: one.note,
        }))
      )
      written += stored
      if (stored < batch.length) {
        refused = 'This device would not store any more. What is shown is saved; the rest is not.'
        break
      }
      sent = (await settle()) && sent
    }
    outcome = { written, sent, merging }
    step = 'done'
  }

  function back() {
    step = step === 'preview' ? 'clock' : step === 'clock' ? 'mapping' : 'file'
  }
</script>

<div class="mt-4 w-full border-t border-white/10 pt-4" data-import={project.id}>
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <p class="meta normal-case">
      {#if filename}
        {filename} → {project.name}
      {:else}
        Adds sessions to {project.name} from a spreadsheet.
      {/if}
    </p>
    {#if file && step !== 'done'}
      <p class="meta">{file.rows.length} rows</p>
    {/if}
  </div>

  {#if refused}
    <p class="mt-3 rounded-lg border border-ember/60 px-3 py-2 text-sm" data-import-refused>
      {refused}
    </p>
  {/if}

  {#if step === 'file'}
    <label class="mt-3 flex flex-col gap-1.5">
      <span class="meta">The file</span>
      <input
        type="file"
        accept=".csv,text/csv"
        data-import-file
        onchange={read}
        class="rounded-lg border border-white/15 bg-ink px-4 py-2.5 text-sm
               file:mr-3 file:rounded-md file:border file:border-white/15 file:bg-transparent
               file:px-3 file:py-1.5 file:text-inherit hover:border-white/40"
      />
    </label>
    <p class="meta mt-2 normal-case">
      Read here on the device. Commas or semicolons, quoted fields either way.
    </p>
  {/if}

  {#if step === 'mapping'}
    <div class="mt-3 flex flex-wrap gap-3">
      {#each [['start', 'Start', true], ['end', 'End', !mapping.duration], ['duration', 'Duration', false], ['date', 'Date', false], ['note', 'Note', false]] as [field, label, required] (field)}
        <label class="flex flex-col gap-1.5">
          <span class="meta">{label}{required ? '' : ' (optional)'}</span>
          <select
            bind:value={mapping[field]}
            aria-label="{label} column"
            data-map={field}
            class="rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm
                   hover:border-white/40"
          >
            <option value={null}>—</option>
            {#each columns as column (column)}
              <option value={column}>{column}</option>
            {/each}
          </select>
        </label>
      {/each}
    </div>

    <p class="meta mt-3 normal-case">
      A Duration column stands in for End. A Date column applies to both times, for a
      file whose start and end are clock times.
    </p>

    <!-- The file's own first rows, so a wrong guess is visible here rather than
         two screens later. -->
    <div class="mt-3 overflow-x-auto rounded-lg border border-white/10">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left">
            {#each columns as column (column)}
              <th class="meta px-3 py-2 whitespace-nowrap">{column}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each file.rows.slice(0, 3) as row, at (at)}
            <tr class="border-t border-white/5">
              {#each row as value, index (index)}
                <td class="px-3 py-2 whitespace-nowrap">{value}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if step === 'clock'}
    {#if dated}
      <p class="mt-3 text-sm" data-clock-answered>
        The file says which clock each row is on, and that is what is used.
      </p>
    {/if}
    <label class="mt-3 flex flex-col gap-1.5">
      <span class="meta">Times without an offset are on</span>
      <select
        bind:value={offset}
        aria-label="The clock the file is on"
        data-clock
        class="max-w-xs rounded-lg border border-white/15 bg-ink px-3 py-2 text-sm
               hover:border-white/40"
      >
        {#each OFFSETS as minutes (minutes)}
          <option value={minutes}>
            {offsetLabel(minutes)}{minutes === utcOffset() ? ", this device's clock" : ''}
          </option>
        {/each}
      </select>
    </label>

    {#if warnsAboutClock}
      <!-- Said rather than worked around: one offset for the whole file is the
           simplification this import makes, and this is where it shows. -->
      <p class="mt-3 rounded-lg border border-ember/60 px-3 py-2 text-sm" data-clock-warning>
        This device's clock changes between {plan.days[0]} and {plan.days.at(-1)}, and one
        offset is used for the whole file. Rows on the far side of the change come in an
        hour out.
      </p>
    {/if}

    <p class="meta mt-3 normal-case">
      Sessions are stored as instants, so a file of wall-clock times cannot be read
      without this.
    </p>
  {/if}

  {#if step === 'preview'}
    <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2" data-import-counts>
      {#each [['ready', 'Ready', plan.counts.ready], ['overlaps', 'Overlaps', plan.counts.overlaps], ['overlaps-file', 'Overlaps within the file', plan.counts['overlaps-file']], ['unreadable', 'Unreadable', plan.counts.unreadable]] as [key, label, count] (key)}
        {#if count}
          <p data-count={key}>
            <span class="numeral text-xl tabular-nums">{count}</span>
            <span class="meta ml-1">{label}</span>
          </p>
        {/if}
      {/each}
    </div>

    {#if plan.counts.overlaps || plan.counts['overlaps-file']}
      <div class="mt-3 flex flex-col gap-1.5">
        <span class="meta">Rows covering minutes already tracked</span>
        <div class="flex flex-wrap gap-2">
          {#each [['skip', 'Skip them'], ['merge', 'Merge into what is there']] as [value, label] (value)}
            <button
              aria-pressed={onOverlap === value}
              data-overlap={value}
              class="meta rounded-md border px-3 py-2 transition
                     {onOverlap === value
                ? 'border-ember bg-dusk/30 text-paper'
                : 'border-white/15 hover:border-white/40'}"
              onclick={() => (onOverlap = value)}
            >
              {label}
            </button>
          {/each}
        </div>
        <p class="meta normal-case">
          Merging keeps the earliest start and the latest end. A project cannot run twice
          over the same minutes, so there is no third answer.
        </p>
      </div>
    {/if}

    <div class="mt-3 max-h-80 overflow-y-auto rounded-lg border border-white/10">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-ink-soft">
          <tr class="text-left">
            <th class="meta px-3 py-2">Line</th>
            <th class="meta px-3 py-2">Reads as</th>
            <th class="meta px-3 py-2 text-right">Length</th>
            <th class="meta px-3 py-2">What happens</th>
          </tr>
        </thead>
        <tbody>
          {#each plan.sessions as row (row.line)}
            {@const skipped =
              row.status === 'unreadable' ||
              (onOverlap === 'skip' && row.status !== 'ready')}
            <tr
              class="border-t border-white/5 {skipped ? 'text-haze' : ''}"
              data-row={row.line}
              data-status={row.status}
            >
              <td class="numeral px-3 py-2 tabular-nums">{row.line}</td>
              <td class="px-3 py-2">
                {#if row.status === 'unreadable'}
                  <span class="truncate">{row.row.filter(Boolean).join(' · ') || '—'}</span>
                {:else}
                  <span class="numeral">{row.reads}</span>
                {/if}
              </td>
              <td class="numeral px-3 py-2 text-right tabular-nums">
                {#if row.startedAt}
                  {formatDuration(
                    (Date.parse(`${row.endedAt}Z`) - Date.parse(`${row.startedAt}Z`)) / 1000
                  )}
                {/if}
              </td>
              <td class="px-3 py-2">
                {#if row.status === 'ready'}
                  Imported
                {:else if skipped}
                  Skipped — {row.why}
                {:else}
                  Merged — {row.why}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if step === 'writing'}
    <p class="mt-3 text-sm" data-import-progress>
      Writing {written} of {total}…
    </p>
  {/if}

  {#if step === 'done'}
    <p class="mt-3 text-sm" data-import-done>
      {#if outcome.written === 0}
        Nothing was written.
      {:else}
        {outcome.written}
        {outcome.written === 1 ? 'session' : 'sessions'} added to {project.name}{outcome.sent
          ? '.'
          : ', and waiting to reach the server.'}
        {#if outcome.merging}
          {outcome.merging} of them covered minutes already tracked and were merged into
          what was there, so the project gains fewer sessions than that.
        {/if}
      {/if}
    </p>
  {/if}

  <div class="mt-4 flex flex-wrap gap-2">
    {#if step !== 'file' && step !== 'writing' && step !== 'done'}
      <button
        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={back}
      >
        Back
      </button>
    {/if}

    {#if step === 'mapping' || step === 'clock'}
      <button
        data-import-next
        disabled={!ready}
        class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift
               disabled:cursor-not-allowed disabled:opacity-30"
        onclick={() => (step = step === 'mapping' ? 'clock' : 'preview')}
      >
        {step === 'mapping' && !ready ? 'Map a start and an end' : 'Next'}
      </button>
    {/if}

    {#if step === 'preview'}
      <button
        data-import-write
        disabled={writing.length === 0}
        class="rounded-lg bg-dusk px-4 py-2 text-sm font-semibold hover:bg-dusk-lift
               disabled:cursor-not-allowed disabled:opacity-30"
        onclick={write}
      >
        Import {writing.length} {writing.length === 1 ? 'session' : 'sessions'}
      </button>
    {/if}

    {#if step !== 'writing'}
      <button
        data-import-close
        class="meta rounded-md border border-white/15 px-3 py-2 hover:border-white/40"
        onclick={onclose}
      >
        {step === 'done' ? 'Close' : 'Cancel'}
      </button>
    {/if}
  </div>
</div>
