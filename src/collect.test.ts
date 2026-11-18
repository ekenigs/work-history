import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { resolveRun, toJsonl } from './collect.ts'
import type { LoadedConfig } from './config.ts'
import { today, yesterday } from './helpers.ts'
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
        folders: [],
        noGit: [],
        remote: {},
        branches: {},
        aliases: {},
      },
    },
  }
}

const WITH_CURSOR = '# Work\n<!-- last-scanned: 2026-10-31 -->\n'

describe(resolveRun, () => {
  it('backfills from the epoch when there is no log', () => {
    expect(resolveRun(loaded(null), { full: false, until: '2026-01-31', repos: [] })).toStrictEqual(
      { mode: 'backfill', since: '1970-01-01', until: '2026-01-31', repos: [] },
    )
  })

  it('backfills when the log has no cursor', () => {
    expect(resolveRun(loaded('# Work\n'), { full: false, repos: [] }).mode).toBe('backfill')
  })

  it('updates from the cursor in the output file', () => {
    const run = resolveRun(loaded(WITH_CURSOR), { full: false, repos: ['acme/app'] })
    expect(run.mode).toBe('update')
    expect(run.since).toBe('2026-10-31')
    expect(run.until).toBe(yesterday())
    expect(run.repos).toStrictEqual(['acme/app'])
  })

  it('stops for a log that has entries but lost its cursor', () => {
    const lost = '# Work\n\n## app (acme/app)\n\n- **Add uploads** (2026-09).\n'
    expect(() => resolveRun(loaded(lost), { full: false, repos: [] })).toThrow(/no valid/u)
    expect(
      resolveRun(loaded(`${lost}<!-- last-scanned: 2026-02-30 -->\n`), { full: true, repos: [] })
        .mode,
    ).toBe('backfill')
    expect(resolveRun(loaded(lost), { full: false, since: '2026-01-01', repos: [] })).toMatchObject(
      { mode: 'backfill', since: '2026-01-01' },
    )
  })

  it('backfills from the epoch with full, whatever the cursor', () => {
    const run = resolveRun(loaded(WITH_CURSOR), { full: true, repos: [] })
    expect(run.mode).toBe('backfill')
    expect(run.since).toBe('1970-01-01')
  })

  it('keeps the mode the log gives when --since moves the start', () => {
    const args = { full: false, since: '2026-01-01', repos: [] }
    expect(resolveRun(loaded(WITH_CURSOR), args)).toMatchObject({
      mode: 'update',
      since: '2026-01-01',
    })
    expect(resolveRun(loaded(null), args)).toMatchObject({ mode: 'backfill', since: '2026-01-01' })
  })

  it('rejects a window that ends on a day still in progress', () => {
    expect(() => resolveRun(loaded(null), { full: false, until: today(), repos: [] })).toThrow(
      /before today/u,
    )
  })

  it('rejects malformed dates', () => {
    expect(() => resolveRun(loaded(null), { full: false, since: '2026-1-1', repos: [] })).toThrow(
      /YYYY-MM-DD/u,
    )
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
