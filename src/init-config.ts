import { existsSync } from 'node:fs'

import type { BackfillConfig, Config } from './config.ts'
import { DEFAULT_OUTPUT, parseConfig, readJsonFile, SCHEMA_URL } from './config.ts'
import { ConfigError } from './errors.ts'
import { tryRun } from './exec.ts'

export interface Detected {
  login: string | null
  emails: string[]
}

export interface Answers {
  login: string
  emails: string[]
  output: string
  canonical: Record<string, string>
  backfill: BackfillConfig
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

/** Answers win; the lists the monthly runs maintain are kept. */
export function buildConfig(existing: Config | null, answers: Answers): ConfigFile {
  return {
    $schema: SCHEMA_URL,
    login: answers.login,
    emails: answers.emails,
    output: answers.output === '' ? DEFAULT_OUTPUT : answers.output,
    canonical: answers.canonical,
    approved: existing?.approved ?? [],
    ignored: existing?.ignored ?? [],
    backfill: answers.backfill,
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

/** How to get a log from here; `collect` alone only prints records. */
export function nextSteps(withSkill: boolean): string {
  const byHand = [
    'Without an agent, add repos to "approved" in the config, then run:',
    '  work-history render backfill    once, to write your log',
    '  work-history render monthly     every month after that',
  ]
  if (!withSkill) {
    return byHand.join('\n')
  }
  return [
    'In your agent, as a slash command or in plain words:',
    '  /work-history backfill    once, to write your log',
    '  /work-history monthly     every month after that',
    '',
    ...byHand,
  ].join('\n')
}
