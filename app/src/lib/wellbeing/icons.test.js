import { describe, expect, it } from 'vitest'

import { ICONS, findIcons, isKnownIcon } from './icons.js'

describe('the icon set', () => {
  it('offers no icon twice', () => {
    expect(new Set(ICONS.map((entry) => entry.icon)).size).toBe(ICONS.length)
  })

  it('gives every icon something to be found by', () => {
    const bare = ICONS.filter((entry) => entry.terms.trim().split(' ').length < 2)
    expect(bare.map((entry) => entry.icon)).toEqual([])
  })

  it('keeps terms lowercase, since the search lowercases what it is given', () => {
    const shouty = ICONS.filter((entry) => entry.terms !== entry.terms.toLowerCase())
    expect(shouty.map((entry) => entry.icon)).toEqual([])
  })
})

describe('knowing an icon', () => {
  it('accepts one from the set', () => {
    expect(isKnownIcon('🏃')).toBe(true)
  })

  it('refuses text, which is the whole reason this exists', () => {
    // The field used to take anything at all, so a habit could be labelled
    // "AAAA" and the chip would render letters where an icon belongs.
    expect(isKnownIcon('AAAA')).toBe(false)
    expect(isKnownIcon('x')).toBe(false)
  })

  it('refuses an emoji this app does not offer', () => {
    expect(isKnownIcon('🦄')).toBe(false)
  })

  it('treats no icon as allowed, because a habit need not have one', () => {
    expect(isKnownIcon('')).toBe(true)
    expect(isKnownIcon(null)).toBe(true)
    expect(isKnownIcon(undefined)).toBe(true)
  })
})

describe('searching', () => {
  it('offers everything for an empty search', () => {
    expect(findIcons('')).toHaveLength(ICONS.length)
    expect(findIcons('   ')).toHaveLength(ICONS.length)
  })

  it('finds an icon by a word that is not its name', () => {
    expect(findIcons('jog').map((entry) => entry.icon)).toContain('🏃')
    expect(findIcons('quit').map((entry) => entry.icon)).toContain('🚭')
  })

  it('matches the start of a word, not a substring anywhere', () => {
    // "at" appears inside "water" and "meditate"; neither starts with it.
    const found = findIcons('at').map((entry) => entry.icon)
    expect(found).not.toContain('💧')
    expect(found).not.toContain('🧘')
  })

  it('ignores case and surrounding space', () => {
    expect(findIcons('  RUN ').map((entry) => entry.icon)).toContain('🏃')
  })

  it('finds an icon pasted in as itself', () => {
    expect(findIcons('🏃')).toEqual([{ icon: '🏃', terms: expect.any(String) }])
  })

  it('finds nothing for a word nothing is tagged with', () => {
    expect(findIcons('zzzz')).toEqual([])
  })
})
