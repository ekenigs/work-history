import { existsSync } from 'node:fs'

import type { Config } from './config.ts'
import { DEFAULT_OUTPUT, emptyBackfill, parseConfig, readJsonFile, SCHEMA_URL } from './config.ts'
import { ConfigError } from './errors.ts'
import { tryRun } from './exec.ts'

const REPO = /^[\w.-]+\/[\w.-]+$/u

export interface Detected {
  login: string | null
  emails: string[]
}

export interface Answers {
  login: string
  emails: string[]
  output: string
  canonical: Record<string, string>
}

/** The config file as written to disk. */
export type ConfigFile = { $schema: string } & Config

function unique(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ''))]
}

/** GitHub login and commit emails from `gh` and git; anything missing is skipped. */
export function detect(cwd: string): Detected {
  const [login = '', id = ''] = (
    tryRun('gh', ['api', 'user', '--jq', '[.login, .id] | @tsv']) ?? ''
  )
    .trim()
    .split('\t')
  const ghEmails = (tryRun('gh', ['api', 'user/emails', '--jq', '.[].email']) ?? '').split('\n')
  const noreply = login !== '' && id !== '' ? [`${id}+${login}@users.noreply.github.com`] : []
  return {
    login: login === '' ? null : login,
    emails: unique([
      tryRun('git', ['config', 'user.email'], cwd) ?? '',
      tryRun('git', ['config', '--global', 'user.email']) ?? '',
      ...ghEmails,
      ...noreply,
    ]),
  }
}

/** The current config, or null when there is none yet. */
export function readExisting(file: string): Config | null {
  if (!existsSync(file)) {
    return null
  }
  const result = parseConfig(readJsonFile(file))
  if ('issues' in result) {
    throw new ConfigError(file, result.issues)
  }
  return result.config
}

/** Comma- or newline-separated list to items. */
export function splitList(text: string): string[] {
  return unique(text.split(/[,\n]/u))
}

/** `copy/repo=main/repo, …` to a map; an error string for a malformed pair. */
export function parseCanonical(text: string): Record<string, string> | string {
  const map: Record<string, string> = {}
  for (const pair of splitList(text)) {
    const [copy = '', main = '', ...rest] = pair.split('=').map((part) => part.trim())
    if (rest.length > 0 || !REPO.test(copy) || !REPO.test(main)) {
      return `"${pair}" is not owner/copy=owner/main`
    }
    map[copy] = main
  }
  return map
}

export function formatCanonical(map: Readonly<Record<string, string>>): string {
  return Object.entries(map)
    .map(([copy, main]) => `${copy}=${main}`)
    .join(', ')
}

/** Answers win; lists the monthly runs maintain and backfill settings are kept. */
export function buildConfig(existing: Config | null, answers: Answers): ConfigFile {
  return {
    $schema: SCHEMA_URL,
    login: answers.login,
    emails: answers.emails,
    output: answers.output === '' ? DEFAULT_OUTPUT : answers.output,
    canonical: answers.canonical,
    approved: existing?.approved ?? [],
    ignored: existing?.ignored ?? [],
    backfill: existing?.backfill ?? emptyBackfill(),
  }
}

/** `buildConfig`, checked the way `collect` checks it, so init never writes a file it rejects. */
export function checkedConfig(file: string, existing: Config | null, answers: Answers): ConfigFile {
  const config = buildConfig(existing, answers)
  const result = parseConfig(config)
  if ('issues' in result) {
    throw new ConfigError(file, result.issues)
  }
  return config
}

export function serialize(config: ConfigFile): string {
  return `${JSON.stringify(config, null, 2)}\n`
}
