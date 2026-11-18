import { readFileSync } from 'node:fs'
import path from 'node:path'

import { ConfigError } from './errors.ts'

export const CONFIG_FILE = 'work-history.config.json'
export const SCHEMA_URL = 'https://raw.githubusercontent.com/ekenigs/work-history/main/schema.json'
export const DEFAULT_OUTPUT = 'work-history.md'

/** Settings that only the backfill (local git) mode reads. */
export interface BackfillConfig {
  /** Folders to scan for git clones, up to three levels deep; `~` expands to the home folder. */
  folders: string[]
  /** Folders without git, as paths; reported with file dates only. */
  noGit: string[]
  /** `owner/name` for a clone whose `origin` remote is missing or wrong, keyed by its path. */
  remote: Record<string, string>
  /** Branches to read instead of the default branch, keyed by clone path. */
  branches: Record<string, string[]>
  /** Renamed owners or repos: `old/name` or `old/*` to `new/name` or `new/*`. */
  aliases: Record<string, string>
}

export interface Config {
  /** GitHub login. */
  login: string
  /** Every email the user commits with. */
  emails: string[]
  /** The work-history Markdown file, relative to the config file. */
  output: string
  /** Repos whose commits are copies of another repo's, mapped to that repo. */
  canonical: Record<string, string>
  /** Repos the update run reads. */
  approved: string[]
  /** Repos the update run never reports as new. */
  ignored: string[]
  backfill: BackfillConfig
}

export interface LoadedConfig {
  config: Config
  /** Absolute path of the config file. */
  file: string
}

const REPO = /^[\w.-]+\/[\w.*-]+$/u
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/iu
const EMAIL = /^[^\s@]+@[^\s@]+$/u

const TOP_KEYS = new Set([
  '$schema',
  'login',
  'emails',
  'output',
  'canonical',
  'approved',
  'ignored',
  'backfill',
])
const BACKFILL_KEYS = new Set(['folders', 'noGit', 'remote', 'branches', 'aliases'])
/** Keys from before `folders`; a config that still has them gets told what replaced them. */
const RETIRED_BACKFILL_KEYS = ['projectsRoot', 'localFolders']

export function isLogin(value: string): boolean {
  return LOGIN.test(value)
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value)
}

/** True for a path that means the same folder from any working directory. */
export function isFullPath(value: string): boolean {
  return path.isAbsolute(value) || value === '~' || value.startsWith('~/')
}

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

class Reader {
  public readonly issues: string[] = []

  public unknownKeys(obj: Obj, allowed: ReadonlySet<string>, where: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        this.issues.push(`${where}${key}: unknown key`)
      }
    }
  }

  public string(obj: Obj, key: string, fallback?: string): string {
    const value = obj[key]
    if (value === undefined && fallback !== undefined) {
      return fallback
    }
    if (typeof value !== 'string' || value === '') {
      this.issues.push(`${key}: expected a non-empty string`)
      return ''
    }
    return value
  }

  public strings(obj: Obj, key: string, check?: RegExp): string[] {
    const value = obj[key] ?? []
    if (!isStringArray(value)) {
      this.issues.push(`${key}: expected an array of strings`)
      return []
    }
    if (check !== undefined) {
      for (const item of value.filter((entry) => !check.test(entry))) {
        this.issues.push(`${key}: "${item}" is not valid`)
      }
    }
    return value
  }

  public stringMap(obj: Obj, key: string, check?: RegExp): Record<string, string> {
    const value = obj[key] ?? {}
    if (!isObject(value) || !Object.values(value).every((item) => typeof item === 'string')) {
      this.issues.push(`${key}: expected an object of strings`)
      return {}
    }
    const map = Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, String(item)]),
    )
    if (check !== undefined) {
      for (const [name, item] of Object.entries(map)) {
        if (!check.test(name) || !check.test(item)) {
          this.issues.push(`${key}: "${name}" -> "${item}" must map owner/name to owner/name`)
        }
      }
    }
    return map
  }

  /** Backfill paths must mean the same folder from any working directory. */
  public fullPaths(backfill: Omit<BackfillConfig, 'aliases'>): void {
    const paths = {
      folders: backfill.folders,
      noGit: backfill.noGit,
      remote: Object.keys(backfill.remote),
      branches: Object.keys(backfill.branches),
    }
    for (const [key, dirs] of Object.entries(paths)) {
      for (const dir of dirs.filter((item) => !isFullPath(item))) {
        this.issues.push(`backfill.${key}: "${dir}" is not a full path; start it with / or ~`)
      }
    }
  }

  public arrayMap(obj: Obj, key: string): Record<string, string[]> {
    const value = obj[key] ?? {}
    if (!isObject(value) || !Object.values(value).every((item) => isStringArray(item))) {
      this.issues.push(`${key}: expected an object of string arrays`)
      return {}
    }
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, isStringArray(item) ? item : []]),
    )
  }
}

export function emptyBackfill(): BackfillConfig {
  return {
    folders: [],
    noGit: [],
    remote: {},
    branches: {},
    aliases: {},
  }
}

function readBackfill(reader: Reader, raw: unknown): BackfillConfig {
  const obj = raw ?? {}
  if (!isObject(obj)) {
    reader.issues.push('backfill: expected an object')
    return emptyBackfill()
  }
  for (const key of RETIRED_BACKFILL_KEYS.filter((retired) => retired in obj)) {
    reader.issues.push(
      `backfill.${key}: replaced by backfill.folders, a list of full paths such as "~/Projects"; noGit, remote and branches take full paths too`,
    )
  }
  reader.unknownKeys(obj, new Set([...BACKFILL_KEYS, ...RETIRED_BACKFILL_KEYS]), 'backfill.')
  const backfill = {
    folders: reader.strings(obj, 'folders'),
    noGit: reader.strings(obj, 'noGit'),
    remote: reader.stringMap(obj, 'remote'),
    branches: reader.arrayMap(obj, 'branches'),
  }
  reader.fullPaths(backfill)
  return {
    ...backfill,
    aliases: reader.stringMap(obj, 'aliases', REPO),
  }
}

/** Checks a parsed config file and fills in defaults. */
export function parseConfig(raw: unknown): { config: Config } | { issues: string[] } {
  if (!isObject(raw)) {
    return { issues: ['expected a JSON object'] }
  }
  const reader = new Reader()
  reader.unknownKeys(raw, TOP_KEYS, '')
  const config: Config = {
    login: reader.string(raw, 'login'),
    emails: reader.strings(raw, 'emails', EMAIL),
    output: reader.string(raw, 'output', DEFAULT_OUTPUT),
    canonical: reader.stringMap(raw, 'canonical', REPO),
    approved: reader.strings(raw, 'approved', REPO),
    ignored: reader.strings(raw, 'ignored', REPO),
    backfill: readBackfill(reader, raw['backfill']),
  }
  if (config.login !== '' && !LOGIN.test(config.login)) {
    reader.issues.push(`login: "${config.login}" is not a GitHub login`)
  }
  if (config.emails.length === 0) {
    reader.issues.push('emails: list at least one email')
  }
  return reader.issues.length > 0 ? { issues: reader.issues } : { config }
}

/** Parses a JSON file; a ConfigError when it is missing or malformed. */
export function readJsonFile(file: string): unknown {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new ConfigError(file, ['file not found; run `work-history init` first'])
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    throw new ConfigError(file, [`invalid JSON (${reason}); fix or delete the file`])
  }
}

/** Reads, checks and fills in a config file. */
export function loadConfig(configPath: string): LoadedConfig {
  const file = path.resolve(configPath)
  const result = parseConfig(readJsonFile(file))
  if ('issues' in result) {
    throw new ConfigError(file, result.issues)
  }
  return { config: result.config, file }
}

/** Absolute path of the work-history file a config points at. */
export function outputPath(loaded: LoadedConfig): string {
  return path.resolve(path.dirname(loaded.file), loaded.config.output)
}

/** A regex alternation of the user's emails, for git's `-E` matching and ours. */
export function emailPattern(emails: readonly string[]): string {
  return emails.map((email) => email.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('|')
}
