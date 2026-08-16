import { describe, expect, test } from 'vitest'

import { parseCsv } from './csv.js'

/**
 * The shapes a real export arrives in.
 *
 * Every case here is one an actual file does — a German Excel's semicolons, the
 * byte-order mark Excel writes and nothing shows, a note containing the very
 * character the file is split on. Getting any of them wrong turns a session
 * into an unreadable row, which is the failure the preview exists to make
 * visible but a poor thing to make it work for.
 */

describe('parseCsv', () => {
  test('reads a comma file', () => {
    const { columns, rows, delimiter } = parseCsv('Start,End\n09:00,10:00\n')

    expect(delimiter).toBe(',')
    expect(columns).toEqual(['Start', 'End'])
    expect(rows).toEqual([['09:00', '10:00']])
  })

  test('reads a semicolon file, which is what a German Excel writes', () => {
    const { columns, rows, delimiter } = parseCsv('Datum;Von;Bis\n16.08.2026;09:00;10:00')

    expect(delimiter).toBe(';')
    expect(columns).toEqual(['Datum', 'Von', 'Bis'])
    expect(rows).toEqual([['16.08.2026', '09:00', '10:00']])
  })

  test('a byte-order mark does not become part of the first column name', () => {
    // Invisible in every editor, and it is the first column — the one the
    // mapping most wants to guess — that carries it.
    const { columns } = parseCsv('﻿Start,End\n09:00,10:00')

    expect(columns[0]).toBe('Start')
  })

  test('a quoted field keeps the delimiter and the newline inside it', () => {
    const { rows } = parseCsv('Start,Note\n09:00,"Call with Ann, then\nthe review"')

    expect(rows).toEqual([['09:00', 'Call with Ann, then\nthe review']])
  })

  test('a doubled quote inside a quoted field is one quote', () => {
    const { rows } = parseCsv('Note\n"She said ""later"""')

    expect(rows[0][0]).toBe('She said "later"')
  })

  test('a short line reads as empty cells, not as missing ones', () => {
    // Otherwise a row with no note has fewer cells than the header and every
    // column after the gap reads one place to the left.
    const { rows } = parseCsv('Start,End,Note\n09:00,10:00')

    expect(rows).toEqual([['09:00', '10:00', '']])
  })

  test('two columns of the same name are told apart', () => {
    // A name is how a column is chosen and how it is keyed on screen, so two
    // alike is both a mapping that silently picks the wrong one and a keyed
    // block Svelte refuses to render.
    const { columns, rows } = parseCsv('Time,Time,Note\n09:00,10:00,Review')

    expect(columns).toEqual(['Time', 'Time (2)', 'Note'])
    expect(rows[0][columns.indexOf('Time (2)')]).toBe('10:00')
  })

  test('an unnamed column still gets a name', () => {
    expect(parseCsv('Start,,End\n1,2,3').columns).toEqual(['Start', 'Column 2', 'End'])
  })

  test('a trailing newline is not a session', () => {
    expect(parseCsv('Start\n09:00\n\n').rows).toEqual([['09:00']])
  })

  test('carriage returns from a Windows file are not part of the values', () => {
    const { columns, rows } = parseCsv('Start,End\r\n09:00,10:00\r\n')

    expect(columns).toEqual(['Start', 'End'])
    expect(rows).toEqual([['09:00', '10:00']])
  })
})
