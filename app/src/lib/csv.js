/**
 * Reading a CSV the way a spreadsheet wrote it.
 *
 * Deliberately small, and deliberately not a dependency: what arrives here is a
 * file somebody exported from a tracker or typed in Excel, and the handful of
 * things those actually do — a byte-order mark, semicolons instead of commas,
 * quoted fields holding both — is a short list. Anything stranger than that is
 * better reported as unreadable than guessed at.
 */

/** The separators worth sniffing for, commonest first. */
const DELIMITERS = [',', ';', '\t']

/**
 * Decide which separator a header line uses.
 *
 * By count outside quotes, not by preference: a German Excel writes semicolons,
 * and a file of one column has no separator at all, in which case any answer is
 * as good as another.
 *
 * @param {string} line The first line of the file.
 * @returns {string}
 */
function sniff(line) {
  let best = ','
  let most = 0
  for (const delimiter of DELIMITERS) {
    let count = 0
    let quoted = false
    for (let at = 0; at < line.length; at += 1) {
      if (line[at] === '"') quoted = !quoted
      else if (!quoted && line[at] === delimiter) count += 1
    }
    if (count > most) {
      most = count
      best = delimiter
    }
  }
  return best
}

/**
 * Parse a CSV file into its header and rows.
 *
 * @param {string} text The file, as text.
 * @returns {{columns: Array<string>, rows: Array<Array<string>>, delimiter: string}}
 *   `rows` excludes the header, and every row is padded to the header's width so
 *   a short line reads as empty cells rather than as missing ones.
 */
export function parseCsv(text) {
  const delimiter = sniff(text.slice(0, text.indexOf('\n') + 1 || text.length))

  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  // Trimmed, which is also what removes Excel's byte-order mark from the first
  // column's name: it counts as whitespace, and left on it a header called
  // "Start" would not match a mapping looking for one.
  const finish = () => {
    row.push(cell.trim())
    cell = ''
  }

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]

    if (quoted) {
      if (char !== '"') {
        cell += char
      } else if (text[at + 1] === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        cell += '"'
        at += 1
      } else {
        quoted = false
      }
      continue
    }

    if (char === '"' && cell === '') {
      quoted = true
    } else if (char === delimiter) {
      finish()
    } else if (char === '\n') {
      finish()
      rows.push(row)
      row = []
    } else if (char !== '\r') {
      cell += char
    }
  }
  if (cell !== '' || row.length) {
    finish()
    rows.push(row)
  }

  // Names have to be unique, and a real file's are not: a column is chosen by
  // its name and keyed on it, so two alike both map to the first and are a
  // duplicate key in the block that lists them, which Svelte refuses to render.
  const taken = new Set()
  const [header = [], ...body] = rows
  const columns = header.map((name, index) => {
    let unique = name || `Column ${index + 1}`
    for (let copy = 2; taken.has(unique); copy += 1) unique = `${name} (${copy})`
    taken.add(unique)
    return unique
  })
  return {
    columns,
    delimiter,
    rows: body
      // A trailing newline leaves one empty row, which is not a session.
      .filter((line) => line.some((value) => value !== ''))
      .map((line) => columns.map((_, index) => line[index] ?? '')),
  }
}
