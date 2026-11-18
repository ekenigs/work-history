import { describe, expect, it } from 'vite-plus/test'

import type { Config } from './config.ts'
import { emptyBackfill, parseConfig, SCHEMA_URL } from './config.ts'
import { ConfigError } from './errors.ts'
import {
  buildConfig,
  checkedConfig,
  listFolders,
  serialize,
  splitList,
  withFolders,
} from './init-config.ts'

function validConfig(raw: unknown): Config {
  const result = parseConfig(raw)
  if ('issues' in result) {
    throw new Error(result.issues.join(', '))
  }
  return result.config
}

const answers = {
  login: 'ada',
  emails: ['ada@work.example'],
  output: 'history.md',
  canonical: { 'acme/ui': 'acme/monorepo' },
  backfill: emptyBackfill(),
}

describe(splitList, () => {
  it('splits on commas and newlines, trims and drops blanks and repeats', () => {
    expect(splitList(' a@x.example, b@x.example\n\na@x.example ,')).toStrictEqual([
      'a@x.example',
      'b@x.example',
    ])
  })
})

describe(withFolders, () => {
  const backfill = { ...emptyBackfill(), projectsRoot: '/srv/code', localFolders: ['acme'] }

  it('lists the scanned folders as paths', () => {
    expect(listFolders(backfill)).toStrictEqual(['/srv/code/acme'])
  })

  it('changes nothing when the folders are the same', () => {
    expect(withFolders(backfill, ['/srv/code/acme'])).toBe(backfill)
  })

  it('scans a single folder from its own root', () => {
    expect(withFolders(backfill, ['/srv/other'])).toMatchObject({
      projectsRoot: '/srv/other',
      localFolders: ['.'],
    })
  })

  it('puts several folders under the folder they share', () => {
    expect(
      withFolders(backfill, ['/srv/code/acme', '/srv/code/side/x', '/srv/code']),
    ).toMatchObject({ projectsRoot: '/srv/code', localFolders: ['acme', 'side/x', '.'] })
  })

  it('clears the folders for an empty answer and keeps the other settings', () => {
    const cleared = withFolders({ ...backfill, noGit: ['acme/sketches'] }, [])
    expect(cleared).toMatchObject({ localFolders: [], noGit: ['acme/sketches'] })
  })
})

describe(buildConfig, () => {
  it('writes a valid config with the schema link for a first run', () => {
    const config = buildConfig(null, answers)
    expect(config.$schema).toBe(SCHEMA_URL)
    const written: unknown = JSON.parse(serialize(config))
    expect(parseConfig(written)).toHaveProperty('config.output', 'history.md')
  })

  it('keeps the lists of an existing config and takes the backfill settings from the answers', () => {
    const existing = validConfig({
      login: 'old',
      emails: ['old@x.example'],
      approved: ['acme/monorepo'],
      ignored: ['acme/fork'],
      backfill: { localFolders: ['acme'] },
    })
    const backfill = { ...existing.backfill, localFolders: ['acme', 'side'] }
    expect(buildConfig(existing, { ...answers, backfill })).toMatchObject({
      login: 'ada',
      emails: ['ada@work.example'],
      approved: ['acme/monorepo'],
      ignored: ['acme/fork'],
      backfill: { localFolders: ['acme', 'side'] },
    })
  })

  it('falls back to the default output path', () => {
    expect(buildConfig(null, { ...answers, output: '' }).output).toBe('work-history.md')
  })
})

describe(checkedConfig, () => {
  it('returns a config that the loader accepts', () => {
    expect(checkedConfig('config.json', null, answers)).toStrictEqual(buildConfig(null, answers))
  })

  it('rejects answers the loader would reject', () => {
    expect(() => checkedConfig('config.json', null, { ...answers, login: 'ada lovelace' })).toThrow(
      ConfigError,
    )
    expect(() =>
      checkedConfig('config.json', null, { ...answers, emails: ['ada@@work.example'] }),
    ).toThrow(/emails/u)
  })
})
