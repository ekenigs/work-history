import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { resolveOptions, toJsonl } from './collect.ts'
import type { LoadedConfig } from './config.ts'
import { UsageError } from './errors.ts'
import { change } from './test-fixtures.ts'

function loaded(markdown: string | null): LoadedConfig {
  const dir = mkdtempSync(path.join(tmpdir(), 'work-history-'))
  if (markdown !== null) {
    writeFileSync(path.join(dir, 'work-history.md'), markdown)
  }
  return {
    file: path.join(dir, 'work-history.config.json'),
    config: {
      login: 'ada',
      emails: ['ada@work.example'],
      output: 'work-history.md',
      canonical: {},
      approved: [],
      ignored: [],
      backfill: {
        projectsRoot: '~/Projects',
        localFolders: [],
        noGit: [],
        remote: {},
        branches: {},
        aliases: {},
      },
    },
  }
}

describe(resolveOptions, () => {
  it('starts backfill at the epoch', () => {
    expect(
      resolveOptions(loaded(null), { mode: 'backfill', until: '2026-01-31', repos: [] }),
    ).toStrictEqual({ since: '1970-01-01', until: '2026-01-31', repos: [] })
  })

  it('starts monthly at the cursor in the output file', () => {
    const options = resolveOptions(loaded('# Work\n<!-- last-scanned: 2026-10-31 -->\n'), {
      mode: 'monthly',
      repos: ['acme/app'],
    })
    expect(options.since).toBe('2026-10-31')
    expect(options.until).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(options.repos).toStrictEqual(['acme/app'])
  })

  it('needs a cursor or --since for monthly', () => {
    expect(() => resolveOptions(loaded(null), { mode: 'monthly', repos: [] })).toThrow(UsageError)
    expect(
      resolveOptions(loaded(null), { mode: 'monthly', since: '2026-01-01', repos: [] }).since,
    ).toBe('2026-01-01')
  })

  it('rejects malformed dates', () => {
    expect(() =>
      resolveOptions(loaded(null), { mode: 'backfill', since: '2026-1-1', repos: [] }),
    ).toThrow(/YYYY-MM-DD/u)
  })
})

describe(toJsonl, () => {
  it('writes one JSON object per line with a trailing newline', () => {
    const text = toJsonl([change({ title: 'a' }), change({ title: 'b' })])
    expect(text.endsWith('\n')).toBe(true)
    expect(
      text
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    ).toMatchObject([{ title: 'a' }, { title: 'b' }])
  })
})
