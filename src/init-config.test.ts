import { describe, expect, it } from 'vite-plus/test'

import type { Config } from './config.ts'
import { emptyBackfill, parseConfig, SCHEMA_URL } from './config.ts'
import { ConfigError } from './errors.ts'
import { buildConfig, checkedConfig, nextSteps, serialize, splitList } from './init-config.ts'

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
      backfill: { folders: ['~/acme'] },
    })
    const backfill = { ...existing.backfill, folders: ['~/acme', '~/side'] }
    expect(buildConfig(existing, { ...answers, backfill })).toMatchObject({
      login: 'ada',
      emails: ['ada@work.example'],
      approved: ['acme/monorepo'],
      ignored: ['acme/fork'],
      backfill: { folders: ['~/acme', '~/side'] },
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

describe(nextSteps, () => {
  it('names the slash commands only when the skill is installed', () => {
    expect(nextSteps(true)).toContain('/work-history ')
    expect(nextSteps(false)).not.toContain('/work-history')
  })

  it('always shows how to write the log with no agent', () => {
    expect(nextSteps(true)).toContain('work-history sync --no-agent')
    expect(nextSteps(false)).toContain('work-history sync --no-agent')
  })
})
