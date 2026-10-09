import { describe, expect, test } from 'vitest'

import { exportTables } from './summary.js'

describe('exportTables', () => {
  const project = { id: 1, name: 'The rewrite', active: true, tags: [] }
  const session = (start, end) => ({
    project_id: 1,
    started_at: `2026-06-10T${start}:00`,
    ended_at: `2026-06-10T${end}:00`,
    utc_offset: 0,
    note: null,
  })
  const tables = exportTables({
    entries: [session('09:00', '12:00'), session('11:00', '14:00')],
    projects: [project],
    tags: [],
    rulesOf: {},
    asOf: Date.UTC(2026, 5, 15, 12),
  })

  test('lists every session as recorded, overlaps included', () => {
    const rows = tables['sessions.csv'].slice(1)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row[7])).toEqual([3, 3])
  })

  test("totals a project's day by the time it covers", () => {
    expect(tables['by-project.csv'].slice(1)).toEqual([['2026-06-10', 'The rewrite', 5]])
  })
})
