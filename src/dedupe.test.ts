import { describe, expect, it } from 'vite-plus/test'

import { dedupe } from './dedupe.ts'
import { change } from './test-fixtures.ts'

describe(dedupe, () => {
  it('merges a PR and its squash commit by SHA; PR data wins', () => {
    const local = change({
      sha: 'abc',
      pr: 5,
      kind: 'pr',
      title: 'Short',
      body: 'commit body',
      role: 'co-author',
      date: '2026-01-01T10:00:00Z',
    })
    const pr = change({
      sha: 'abc',
      pr: 5,
      kind: 'pr',
      title: 'Long PR title',
      body: 'pr body',
      sources: ['github-pr'],
      date: '2026-01-01T09:00:00Z',
      size: { additions: 1, deletions: 2, files: 3 },
    })
    expect(dedupe([local, pr])).toMatchObject([
      {
        title: 'Long PR title',
        body: 'pr body',
        role: 'author',
        sources: ['local', 'github-pr'],
        size: { additions: 1, deletions: 2, files: 3 },
      },
    ])
  })

  it('falls back to repo + PR number and keeps unrelated commits apart', () => {
    const squash = change({ sha: 'aaa', pr: 7, kind: 'pr', title: 'Squash' })
    const pr = change({ sha: 'bbb', pr: 7, kind: 'pr', title: 'PR', sources: ['github-pr'] })
    const direct = change({ sha: 'ccc', title: 'Direct push' })
    const otherRepo = change({ repo: 'o/other', sha: 'ddd', pr: 7, kind: 'pr' })
    const out = dedupe([squash, pr, direct, otherRepo])
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ title: 'PR', sources: ['local', 'github-pr'] })
  })

  it('keeps commits apart that reuse a PR number for a different change', () => {
    // A repo that restarts its PR numbering has two PRs behind #13.
    const old13 = change({
      repo: 'o/dapp',
      sha: '02b596c3',
      pr: 13,
      kind: 'pr',
      title: 'Workflow with steps',
      date: '2023-07-10T00:00:00Z',
    })
    const new13 = change({
      repo: 'o/dapp',
      sha: '893847ee',
      pr: 13,
      kind: 'pr',
      title: 'Updated SDK packages',
      date: '2024-06-20T00:00:00Z',
    })
    const ghCopy = { ...old13, sources: ['github-commit'] }
    expect(dedupe([old13, new13, ghCopy])).toMatchObject([
      { title: 'Workflow with steps', sources: ['local', 'github-commit'] },
      { title: 'Updated SDK packages' },
    ])
  })

  it('collapses one PR whose squash commit sits on several branches', () => {
    const main = change({
      sha: 's1',
      pr: 42,
      kind: 'pr',
      title: 'Add login',
      date: '2025-01-01T10:00:00Z',
    })
    const release = change({
      sha: 's2',
      pr: 42,
      kind: 'pr',
      title: 'add  login ',
      date: '2025-01-03T10:00:00Z',
    })
    const gh = change({
      sha: 's3',
      pr: 42,
      kind: 'pr',
      title: 'Add login',
      sources: ['github-commit'],
      date: '2025-01-04T10:00:00Z',
    })
    expect(dedupe([main, release, gh])).toHaveLength(1)
  })

  describe('a GitHub PR joins its own squash commit, not an older PR with the same number', () => {
    const older = change({
      repo: 'o/dapp',
      sha: 'd3558d0e',
      pr: 607,
      kind: 'pr',
      title: 'HRMP Channels',
      date: '2024-05-14T00:00:00Z',
    })
    const squash = change({
      repo: 'o/dapp',
      sha: 'n607',
      pr: 607,
      kind: 'pr',
      title: 'Fix fees',
      date: '2025-02-01T12:00:05Z',
    })
    const pr = change({
      repo: 'o/dapp',
      sha: 'other-branch-sha',
      pr: 607,
      kind: 'pr',
      title: 'Fix fee display',
      sources: ['github-pr'],
      date: '2025-02-01T12:00:00Z',
    })

    it.each([
      ['older first', [older, squash, pr]],
      ['PR first', [pr, older, squash]],
    ])('%s', (_name, changes) => {
      const sorted = dedupe(changes).toSorted((a, b) => a.date.localeCompare(b.date))
      expect(sorted).toHaveLength(2)
      expect(sorted[0]).toMatchObject({ title: 'HRMP Channels', sources: ['local'] })
      expect(sorted[1]?.title).toBe('Fix fee display')
      expect(sorted[1]?.sources.toSorted()).toStrictEqual(['github-pr', 'local'])
    })
  })

  it('does not mutate its input', () => {
    const input = [change({ sha: 'x' }), change({ sha: 'x', sources: ['github-commit'] })]
    dedupe(input)
    expect(input[0]?.sources).toStrictEqual(['local'])
  })
})
