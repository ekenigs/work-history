import { describe, expect, it } from 'vite-plus/test'

import type { Config } from './config.ts'
import { emptyBackfill } from './config.ts'
import { entryLine, isNoise, render } from './render.ts'
import { change } from './test-fixtures.ts'
import type { Change, CollectRecord, RepoRecord } from './types.ts'

const config: Config = {
  login: 'ada',
  emails: ['ada@work.example'],
  output: 'work-history.md',
  canonical: { 'acme/ui-mirror': 'acme/ui' },
  approved: ['acme/api', 'acme/ui'],
  ignored: ['acme/fork'],
  backfill: emptyBackfill(),
}

function repo(name: string, overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    type: 'repo',
    repo: name,
    canonical: null,
    localPath: null,
    branches: ['main'],
    description: null,
    first: null,
    last: null,
    counts: { author: 1, 'co-author': 0 },
    warnings: [],
    ...overrides,
  }
}

/** A merged PR; `ref` is `owner/name#number`. */
function pr(ref: string, title: string, date: string): Change {
  const [name = '', number = ''] = ref.split('#')
  return change({ repo: name, kind: 'pr', pr: Number(number), sha: `sha${number}`, title, date })
}

function records(...items: CollectRecord[]): CollectRecord[] {
  return [
    ...items,
    { type: 'run', mode: 'update', since: '2026-09-30', until: '2026-10-31', warnings: [] },
  ]
}

describe(entryLine, () => {
  it('links a PR and states its size', () => {
    expect(
      entryLine({
        ...pr('acme/api#7', 'Add *rate* limits', '2026-10-02T00:00:00Z'),
        size: { additions: 120, deletions: 4, files: 6 },
      }),
    ).toBe(
      String.raw`- **Add \*rate\* limits** (2026-10). [#7](https://github.com/acme/api/pull/7); +120/−4 lines across 6 files.`,
    )
  })

  it('says file for one file', () => {
    expect(entryLine({ ...change({}), size: { additions: 1, deletions: 0, files: 1 } })).toMatch(
      /across 1 file\.$/u,
    )
  })

  it('links a direct commit by short SHA and marks co-authored work', () => {
    expect(
      entryLine(
        change({ repo: 'acme/api', sha: 'abcdef123456', title: 'Fix login', role: 'co-author' }),
      ),
    ).toBe(
      '- **Fix login** (2026-01). [`abcdef1`](https://github.com/acme/api/commit/abcdef123456). _(co)_',
    )
  })
})

describe(isNoise, () => {
  it.each([
    'chore(deps): bump vite',
    'Bump react from 18 to 19',
    'Merge branch main',
    'wip',
    'Lint',
  ])('skips %j', (title) => {
    expect(isNoise(change({ title }))).toBe(true)
  })

  it('keeps real work', () => {
    expect(isNoise(change({ title: 'Add file uploads' }))).toBe(false)
  })
})

describe(render, () => {
  it('creates the log with a cursor and a section per approved repo', () => {
    const result = render(
      null,
      records(
        repo('acme/api', { description: 'The Acme API' }),
        pr('acme/api#1', 'Add auth', '2026-10-03T00:00:00Z'),
        pr('acme/api#2', 'Add billing', '2026-10-20T00:00:00Z'),
        repo('acme/other'),
        pr('acme/other#3', 'Elsewhere', '2026-10-05T00:00:00Z'),
      ),
      config,
    )
    expect(result.markdown).toBe(
      [
        '# Work history',
        '',
        '<!-- last-scanned: 2026-10-31 -->',
        '',
        '## api (acme/api)',
        '',
        'The Acme API. 2026-10.',
        '',
        '- **Add billing** (2026-10). [#2](https://github.com/acme/api/pull/2).',
        '- **Add auth** (2026-10). [#1](https://github.com/acme/api/pull/1).',
        '',
      ].join('\n'),
    )
    expect(result).toMatchObject({ added: 2, projects: ['acme/api'], unsorted: ['acme/other'] })
  })

  it('adds to an existing section, widens its range, moves it first and the cursor on', () => {
    const before = [
      '# Work history',
      '',
      '<!-- last-scanned: 2026-09-30 -->',
      '',
      '## UI (acme/ui)',
      '',
      'The UI. 2025-01 → 2026-02.',
      '',
      '- **Rich entry** (2026-02). Old content.',
      '',
      '## API (acme/api)',
      '',
      'The API. 2026-05.',
      '',
      '- **Old** (2026-05).',
      '',
    ].join('\n')
    const result = render(
      before,
      records(repo('acme/api'), pr('acme/api#9', 'Add search', '2026-10-09T00:00:00Z')),
      config,
    )
    expect(result.markdown).toBe(
      [
        '# Work history',
        '',
        '<!-- last-scanned: 2026-10-31 -->',
        '',
        '## API (acme/api)',
        '',
        'The API. 2026-05 → 2026-10.',
        '',
        '- **Add search** (2026-10). [#9](https://github.com/acme/api/pull/9).',
        '- **Old** (2026-05).',
        '',
        '## UI (acme/ui)',
        '',
        'The UI. 2025-01 → 2026-02.',
        '',
        '- **Rich entry** (2026-02). Old content.',
        '',
      ].join('\n'),
    )
  })

  it('adds nothing twice and never moves the cursor back', () => {
    const input = records(repo('acme/api'), pr('acme/api#1', 'Add auth', '2026-10-03T00:00:00Z'))
    const once = render(null, input, config)
    const later = once.markdown.replace('2026-10-31', '2026-11-30')
    const twice = render(later, input, config)
    expect(twice.added).toBe(0)
    expect(twice.markdown).toBe(later)
  })

  it('writes a copy under its canonical repo, once', () => {
    const result = render(
      null,
      records(
        repo('acme/ui', { description: 'The UI' }),
        pr('acme/ui#4', 'Add tabs', '2026-10-04T10:00:00Z'),
        repo('acme/ui-mirror', { canonical: 'acme/ui' }),
        change({
          repo: 'acme/ui-mirror',
          sha: 'm1',
          title: 'Add tabs',
          date: '2026-10-04T12:00:00Z',
        }),
        change({
          repo: 'acme/ui-mirror',
          sha: 'm2',
          title: 'Add menus',
          date: '2026-10-06T00:00:00Z',
        }),
      ),
      config,
    )
    expect(result.added).toBe(2)
    expect(result.markdown).toContain('## ui (acme/ui)')
    expect(result.markdown).not.toContain('## ui-mirror')
    expect(result.markdown).toContain('**Add menus**')
  })

  it('skips noise and lists new projects without writing them', () => {
    const result = render(
      null,
      records(
        { type: 'new-project', repo: 'acme/new', evidence: ['PR #1 Something'] },
        repo('acme/api'),
        pr('acme/api#5', 'chore(deps): bump vite', '2026-10-01T00:00:00Z'),
      ),
      config,
    )
    expect(result).toMatchObject({ added: 0, unsorted: ['acme/new'] })
    expect(result.markdown).toBe('# Work history\n\n<!-- last-scanned: 2026-10-31 -->\n')
  })
})
