import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type { BackfillConfig, Config } from './config.ts'
import { DEFAULT_OUTPUT, parseConfig, readJsonFile, SCHEMA_URL } from './config.ts'
import { ConfigError } from './errors.ts'
import { tryRun } from './exec.ts'
import { expandHome } from './local.ts'

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

/** The folders the backfill scans for clones, as paths. */
export function listFolders(backfill: BackfillConfig): string[] {
  return backfill.localFolders.map((folder) => path.join(backfill.projectsRoot, folder))
}

/** The deepest folder that holds every one of `dirs`. */
function commonDir(dirs: readonly string[]): string {
  const [first = [], ...rest] = dirs.map((dir) => dir.split(path.sep))
  const differs = first.findIndex((part, index) => rest.some((parts) => parts[index] !== part))
  const shared = differs === -1 ? first : first.slice(0, differs)
  return shared.join(path.sep) || path.sep
}

function collapseHome(dir: string): string {
  const home = homedir()
  return dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir
}

/**
 * Backfill settings that scan `folders`. The same folders as before change
 * nothing, so the paths that `remote` and `branches` are keyed by stay valid.
 */
export function withFolders(backfill: BackfillConfig, folders: readonly string[]): BackfillConfig {
  const current = listFolders(backfill)
  if (folders.length === current.length && folders.every((folder) => current.includes(folder))) {
    return backfill
  }
  if (folders.length === 0) {
    return { ...backfill, localFolders: [] }
  }
  const dirs = folders.map((folder) => path.resolve(expandHome(folder)))
  const root = commonDir(dirs)
  return {
    ...backfill,
    projectsRoot: collapseHome(root),
    localFolders: dirs.map((dir) => path.relative(root, dir) || '.'),
  }
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
