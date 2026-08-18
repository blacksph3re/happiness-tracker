import { describe, expect, test } from 'vitest'

import { formatBytes, formatUptime } from './format.js'

describe('formatBytes', () => {
  test('small counts stay in bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  test('decimal units, so a 50 GB disk reads as 50 GB', () => {
    // Binary units would call this 46.6 GB, which disagrees with every hosting
    // panel the number sits beside.
    expect(formatBytes(50_000_000_000)).toBe('50.0 GB')
  })

  test('a decimal appears only where it says something', () => {
    expect(formatBytes(327_680)).toBe('328 kB')
    expect(formatBytes(1_400_000_000)).toBe('1.4 GB')
  })

  test('nonsense reads as nothing rather than NaN', () => {
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(undefined)).toBe('0 B')
  })
})

describe('formatUptime', () => {
  test('a process just started says so', () => {
    expect(formatUptime(0)).toBe('just now')
    expect(formatUptime(3)).toBe('just now')
  })

  test('seconds, then minutes, then hours', () => {
    expect(formatUptime(42)).toBe('42s')
    expect(formatUptime(90)).toBe('1m')
    expect(formatUptime(3600 * 4 + 60 * 12)).toBe('4h 12m')
  })

  test('at most two units, largest first', () => {
    // 3 days, 4 hours, 12 minutes: the minutes are dropped rather than making
    // a string nobody reads to the end of.
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 12 * 60)).toBe('3d 4h')
  })

  test('a unit that is zero is skipped rather than shown', () => {
    // 2 days and 5 minutes: "2d 0h" would be worse than saying what is there.
    expect(formatUptime(2 * 86_400 + 5 * 60)).toBe('2d 5m')
  })
})
