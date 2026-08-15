/**
 * Turning what the app holds into files a person can keep.
 *
 * This used to be the server's job, and moving it here settles the question
 * `CLAUDE.md` raised when the derivations were ported: *the screen and the
 * spreadsheet cannot drift*. They cannot now, in the strongest sense — the
 * numbers in the file are the numbers on the page, from the same functions.
 * It also means the export works with no connection, which the server-rendered
 * one never could.
 *
 * The zip is written by hand rather than by a library. It holds three small
 * text files, so nothing is compressed and the format is the twenty lines
 * below: a local header per file, then a directory listing them.
 */

/** Deflate is not used, so every entry is stored as-is. */
const STORED = 0

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * The checksum every zip entry carries.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Render rows as CSV.
 *
 * @param {Array<Array<unknown>>} rows The header row, then the body.
 * @returns {string} With a byte-order mark, so Excel reads it as UTF-8 rather
 *   than as the system's legacy codepage — which is what turns a project called
 *   "Büro" into mojibake in the one program most likely to open this.
 */
export function toCsv(rows) {
  const cell = (value) => {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

/**
 * Pack named files into a zip.
 *
 * @param {Record<string, string>} files Text by name.
 * @returns {Blob}
 */
export function toZip(files) {
  const encoder = new TextEncoder()
  const parts = []
  const directory = []
  let offset = 0

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const body = encoder.encode(text)
    const sum = crc32(body)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true) // the names are UTF-8
    local.setUint16(8, STORED, true)
    local.setUint32(14, sum, true)
    local.setUint32(18, body.length, true)
    local.setUint32(22, body.length, true)
    local.setUint16(26, nameBytes.length, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, body)

    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint16(10, STORED, true)
    entry.setUint32(16, sum, true)
    entry.setUint32(20, body.length, true)
    entry.setUint32(24, body.length, true)
    entry.setUint16(28, nameBytes.length, true)
    entry.setUint32(42, offset, true)
    directory.push(new Uint8Array(entry.buffer), nameBytes)

    offset += 30 + nameBytes.length + body.length
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, Object.keys(files).length, true)
  end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, directorySize, true)
  end.setUint32(16, offset, true)

  return new Blob([...parts, ...directory, new Uint8Array(end.buffer)], {
    type: 'application/zip',
  })
}

/**
 * Hand a blob to the browser as a download.
 *
 * @param {Blob} blob
 * @param {string} name
 */
export function save(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  // Attached and revoked a tick later: revoking synchronously can cancel the
  // download before the browser has read the blob.
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
