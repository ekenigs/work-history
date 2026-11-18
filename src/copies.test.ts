import { describe, expect, it } from 'vite-plus/test'

import type { CopyPair } from './copies.ts'
import { currentChoice, findCopies, withChoice } from './copies.ts'

function keys(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${String(index)} ${prefix}`)
}

/** `findCopies` over repos given as name to commit keys. */
function copiesIn(repos: Readonly<Record<string, string[]>>): CopyPair[] {
  const entries = Object.entries(repos).map(([name, own]) => [name, new Set(own)] as const)
  return findCopies(new Map(entries))
}

const ui = keys('ui', 4)
const monorepo = [...ui, ...keys('api', 6)]
const pair = { likelySource: 'acme/monorepo', other: 'acme/ui', shared: 4 }

describe(findCopies, () => {
  it('pairs a repo with the larger one that holds its commits', () => {
    const found = copiesIn({
      'acme/ui': ui,
      'acme/monorepo': monorepo,
      'acme/site': keys('site', 5),
    })
    expect(found).toStrictEqual([pair])
  })

  it('ignores a couple of shared commits in repos with more work', () => {
    const tools = [...keys('ui', 2), ...keys('tools', 5)]
    expect(copiesIn({ 'acme/tools': tools, 'acme/monorepo': monorepo })).toStrictEqual([])
  })

  it('pairs a small repo whose every commit is a copy', () => {
    const found = copiesIn({ 'acme/fix': keys('ui', 1), 'acme/monorepo': monorepo })
    expect(found).toStrictEqual([{ likelySource: 'acme/monorepo', other: 'acme/fix', shared: 1 }])
  })

  it('points every copy of one history at the largest repo', () => {
    const found = copiesIn({ 'acme/ui': ui, 'acme/ui-mirror': ui, 'acme/monorepo': monorepo })
    expect(found.map(({ likelySource }) => likelySource)).toStrictEqual([
      'acme/monorepo',
      'acme/monorepo',
    ])
  })

  it('skips repos with no commits by the user', () => {
    expect(copiesIn({ 'acme/a': [], 'acme/b': [] })).toStrictEqual([])
  })
})

describe(withChoice, () => {
  it('maps the other repo to the chosen source', () => {
    expect(withChoice({}, pair, 'acme/monorepo')).toStrictEqual({ 'acme/ui': 'acme/monorepo' })
    expect(withChoice({}, pair, 'acme/ui')).toStrictEqual({ 'acme/monorepo': 'acme/ui' })
  })

  it('replaces the pair’s old mapping and keeps the others', () => {
    const canonical = { 'acme/ui': 'acme/monorepo', 'acme/docs': 'acme/monorepo' }
    expect(withChoice(canonical, pair, 'acme/monorepo')).toStrictEqual(canonical)
    expect(withChoice(canonical, pair, 'acme/ui')).toStrictEqual({
      'acme/docs': 'acme/ui',
      'acme/monorepo': 'acme/ui',
    })
    expect(withChoice(canonical, pair, null)).toStrictEqual({ 'acme/docs': 'acme/monorepo' })
  })

  it('points a copy of the new copy at the new source', () => {
    const canonical = { 'acme/ui-mirror': 'acme/monorepo' }
    expect(withChoice(canonical, pair, 'acme/ui')).toStrictEqual({
      'acme/ui-mirror': 'acme/ui',
      'acme/monorepo': 'acme/ui',
    })
  })

  it('follows the mapping the chosen source already has', () => {
    const canonical = { 'acme/ui': 'acme/design' }
    expect(withChoice(canonical, pair, 'acme/ui')).toStrictEqual({
      'acme/ui': 'acme/design',
      'acme/monorepo': 'acme/design',
    })
  })
})

describe(currentChoice, () => {
  it('reads the source the config already names for a pair', () => {
    expect(currentChoice({ 'acme/ui': 'acme/monorepo' }, pair)).toBe('acme/monorepo')
    expect(currentChoice({ 'acme/monorepo': 'acme/ui' }, pair)).toBe('acme/ui')
    expect(currentChoice({ 'acme/ui': 'acme/other' }, pair)).toBeUndefined()
  })
})
