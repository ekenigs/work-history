import type { Change } from './types.ts'

/** A change with neutral defaults; tests override what they care about. */
export function change(overrides: Partial<Change>): Change {
  return {
    type: 'change',
    repo: 'o/r',
    kind: 'commit',
    date: '2026-01-02T00:00:00Z',
    pr: null,
    sha: null,
    role: 'author',
    title: 't',
    body: '',
    sources: ['local'],
    size: null,
    ...overrides,
  }
}
