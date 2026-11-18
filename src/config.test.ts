import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { loadConfig, outputPath, parseConfig } from './config.ts'
import { ConfigError } from './errors.ts'

const root = path.join(import.meta.dirname, '..')

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8'))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Sorted keys of the object at a path inside parsed JSON. */
function keysAt(value: unknown, ...keys: string[]): string[] {
  let node: unknown = value
  for (const key of keys) {
    node = isObject(node) ? node[key] : undefined
  }
  return isObject(node) ? Object.keys(node).toSorted() : []
}

function issuesOf(raw: unknown): string[] {
  const result = parseConfig(raw)
  return 'issues' in result ? result.issues : []
}

describe(parseConfig, () => {
  it('accepts the example config', () => {
    expect(parseConfig(readJson('config.example.json'))).toHaveProperty('config.login', 'octocat')
  })

  it('fills in defaults for a minimal config', () => {
    expect(parseConfig({ login: 'ada', emails: ['ada@work.example'] })).toStrictEqual({
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
    })
  })

  it('reports every problem at once', () => {
    expect(
      issuesOf({
        login: 'not a login',
        emails: [],
        approved: ['no-slash'],
        canonical: { 'a/b': 'nope' },
        backfill: { typo: true },
        extra: 1,
      }),
    ).toStrictEqual([
      'extra: unknown key',
      'canonical: "a/b" -> "nope" must map owner/name to owner/name',
      'approved: "no-slash" is not valid',
      'backfill.typo: unknown key',
      'login: "not a login" is not a GitHub login',
      'emails: list at least one email',
    ])
  })

  it('says what replaced the folder settings of older configs', () => {
    const issues = issuesOf({
      login: 'ada',
      emails: ['ada@work.example'],
      backfill: { projectsRoot: '~/Projects', localFolders: ['acme'] },
    })
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatch(/^backfill\.projectsRoot: replaced by backfill\.folders/u)
    expect(issues[1]).toMatch(/^backfill\.localFolders: replaced by backfill\.folders/u)
  })

  it('rejects backfill paths that depend on the working directory', () => {
    expect(
      issuesOf({
        login: 'ada',
        emails: ['ada@work.example'],
        backfill: {
          folders: ['~/Projects', '/srv/code', 'acme'],
          noGit: ['side-projects/sketches'],
          remote: { 'acme/monorepo': 'acme/monorepo' },
          branches: { './monorepo': ['main'] },
        },
      }),
    ).toStrictEqual([
      'backfill.folders: "acme" is not a full path; start it with / or ~',
      'backfill.noGit: "side-projects/sketches" is not a full path; start it with / or ~',
      'backfill.remote: "acme/monorepo" is not a full path; start it with / or ~',
      'backfill.branches: "./monorepo" is not a full path; start it with / or ~',
    ])
  })

  it('rejects wrong types', () => {
    expect(issuesOf([])).toStrictEqual(['expected a JSON object'])
    expect(issuesOf({ login: 1, emails: 'a@b.c' })).toStrictEqual([
      'login: expected a non-empty string',
      'emails: expected an array of strings',
      'emails: list at least one email',
    ])
  })
})

describe('schema.json', () => {
  it('lists the same keys the parser accepts', () => {
    const schema = readJson('schema.json')
    const example = readJson('config.example.json')
    expect(keysAt(schema, 'properties')).toStrictEqual(keysAt(example))
    expect(keysAt(schema, 'properties', 'backfill', 'properties')).toStrictEqual(
      keysAt(example, 'backfill'),
    )
  })
})

describe(loadConfig, () => {
  it('resolves the output path next to the config file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'work-history-'))
    const file = path.join(dir, 'work-history.config.json')
    writeFileSync(file, JSON.stringify({ login: 'ada', emails: ['ada@work.example'] }))
    expect(outputPath(loadConfig(file))).toBe(path.join(dir, 'work-history.md'))
  })

  it('throws a ConfigError for a missing file or bad JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'work-history-'))
    const file = path.join(dir, 'bad.json')
    expect(() => loadConfig(file)).toThrow(ConfigError)
    writeFileSync(file, '{ nope')
    expect(() => loadConfig(file)).toThrow(/invalid JSON/u)
  })
})
