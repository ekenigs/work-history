import { describe, expect, it } from 'vite-plus/test'

import type { Config } from './config.ts'
import { parseConfig, SCHEMA_URL } from './config.ts'
import { ConfigError } from './errors.ts'
import {
  buildConfig,
  checkedConfig,
  formatCanonical,
  parseCanonical,
  serialize,
  splitList,
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
}

describe(splitList, () => {
  it('splits on commas and newlines, trims and drops blanks and repeats', () => {
    expect(splitList(' a@x.example, b@x.example\n\na@x.example ,')).toStrictEqual([
      'a@x.example',
      'b@x.example',
    ])
  })
})

describe('canonical mappings', () => {
  const map = { 'acme/ui': 'acme/monorepo', 'acme/docs': 'acme/monorepo' }

  it('parses copy=source pairs', () => {
    expect(parseCanonical('acme/ui=acme/monorepo, acme/docs = acme/monorepo')).toStrictEqual(map)
  })

  it('formats a map back to text', () => {
    expect(formatCanonical(map)).toBe('acme/ui=acme/monorepo, acme/docs=acme/monorepo')
  })

  it('accepts an empty answer', () => {
    expect(parseCanonical('')).toStrictEqual({})
  })

  it.each(['acme/ui', 'acme/ui=monorepo', 'a/b=c/d=e/f'])('rejects %j', (text) => {
    expect(parseCanonical(text)).toBeTypeOf('string')
  })
})

describe(buildConfig, () => {
  it('writes a valid config with the schema link for a first run', () => {
    const config = buildConfig(null, answers)
    expect(config.$schema).toBe(SCHEMA_URL)
    const written: unknown = JSON.parse(serialize(config))
    expect(parseConfig(written)).toHaveProperty('config.output', 'history.md')
  })

  it('keeps the lists and backfill settings of an existing config', () => {
    const existing = validConfig({
      login: 'old',
      emails: ['old@x.example'],
      approved: ['acme/monorepo'],
      ignored: ['acme/fork'],
      backfill: { localFolders: ['acme'] },
    })
    expect(buildConfig(existing, answers)).toMatchObject({
      login: 'ada',
      emails: ['ada@work.example'],
      approved: ['acme/monorepo'],
      ignored: ['acme/fork'],
      backfill: { localFolders: ['acme'] },
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
