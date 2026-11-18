import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type { BackfillConfig } from './config.ts'
import { tryRun } from './exec.ts'
import {
  cleanBody,
  extractPrNumber,
  hasCoAuthorTrailer,
  inWindow,
  isOwnEmail,
  isoDay,
  repoFromRemoteUrl,
  resolveAlias,
  stripPrSuffix,
} from './helpers.ts'
import type { Change, RepoRecord, Role } from './types.ts'

/** How deep under a configured folder to look for git repos. */
const SCAN_DEPTH = 3
const STALE_DAYS = 365
const DAY_MS = 86_400_000
const STALE_MS = STALE_DAYS * DAY_MS

export interface LocalRepo {
  absPath: string
  repo: string
  refs: string[]
  warnings: string[]
}

export function expandHome(dir: string): string {
  return dir.startsWith('~') ? path.join(homedir(), dir.slice(1)) : dir
}

/** A folder's entries; none when it cannot be read. */
function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isScannable(name: string): boolean {
  return name !== 'node_modules' && !name.startsWith('.')
}

function findGitDirs(dir: string, depth: number): string[] {
  if (depth < 0 || !existsSync(dir)) {
    return []
  }
  if (existsSync(path.join(dir, '.git'))) {
    return [dir]
  }
  return entries(dir)
    .filter((entry) => entry.isDirectory() && isScannable(entry.name))
    .flatMap((entry) => findGitDirs(path.join(dir, entry.name), depth - 1))
}

function refExists(cwd: string, ref: string): boolean {
  return tryRun('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd) !== null
}

function resolveLocalRefs(cwd: string, override: readonly string[] | undefined): string[] {
  if (override !== undefined) {
    return override
      .map((branch) =>
        [`refs/remotes/origin/${branch}`, `refs/remotes/${branch}`].find((ref) =>
          refExists(cwd, ref),
        ),
      )
      .filter((ref) => ref !== undefined)
  }
  const head = tryRun('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd)?.trim()
  const found = [head, 'refs/remotes/origin/main', 'refs/remotes/origin/master'].find(
    (ref) => ref !== undefined && ref !== '' && refExists(cwd, ref),
  )
  return found === undefined ? [] : [found]
}

function isStale(absPath: string): boolean {
  const fetchHead = path.join(absPath, '.git', 'FETCH_HEAD')
  return !existsSync(fetchHead) || statSync(fetchHead).mtimeMs < Date.now() - STALE_MS
}

function localRepo(cfg: BackfillConfig, root: string, absPath: string): LocalRepo {
  const relPath = path.relative(root, absPath)
  const originUrl = tryRun('git', ['remote', 'get-url', 'origin'], absPath) ?? ''
  const raw = cfg.remote[relPath] ?? repoFromRemoteUrl(originUrl) ?? relPath
  const refs = resolveLocalRefs(absPath, cfg.branches[relPath])
  const warnings: string[] = []
  if (isStale(absPath)) {
    warnings.push('stale-clone')
  }
  if (refs.length === 0) {
    warnings.push('no-default-ref')
  }
  return { absPath, repo: resolveAlias(raw, cfg.aliases), refs, warnings }
}

/** Every git clone under the configured folders, skipping `noGit` ones. */
export function localRepos(cfg: BackfillConfig, root: string): LocalRepo[] {
  return cfg.localFolders
    .filter((folder) => !cfg.noGit.includes(folder))
    .flatMap((folder) => findGitDirs(path.join(root, folder), SCAN_DEPTH))
    .map((absPath) => localRepo(cfg, root, absPath))
}

const FS = '\u001F'
const RS = '\u001E'
const END = '\u001D'

function statNumber(stat: string, pattern: RegExp): number {
  return Number(pattern.exec(stat)?.groups?.['n'] ?? 0)
}

function role(email: string, message: string, pattern: string): Role | null {
  if (isOwnEmail(email, pattern)) {
    return 'author'
  }
  return hasCoAuthorTrailer(message, pattern) ? 'co-author' : null
}

interface LogEntry {
  sha: string
  email: string
  date: string
  subject: string
  message: string
  stat: string
}

function parseLogChunk(chunk: string): LogEntry {
  const [head = '', stat = ''] = chunk.split(END)
  const [sha = '', email = '', date = '', subject = '', message = ''] = head.split(FS)
  return { sha, email, date, subject, message, stat }
}

function entryToChange(repo: string, entry: LogEntry, entryRole: Role): Change {
  const pr = extractPrNumber(entry.subject)
  return {
    type: 'change',
    repo,
    kind: pr === null ? 'commit' : 'pr',
    date: entry.date,
    pr,
    sha: entry.sha,
    role: entryRole,
    title: stripPrSuffix(entry.subject),
    body: cleanBody(entry.message.split('\n').slice(1).join('\n')),
    sources: ['local'],
    size: {
      additions: statNumber(entry.stat, /(?<n>\d+) insertions?/u),
      deletions: statNumber(entry.stat, /(?<n>\d+) deletions?/u),
      files: statNumber(entry.stat, /(?<n>\d+) files? changed/u),
    },
  }
}

export interface LocalWindow {
  pattern: string
  since: string
  until: string
}

/** Log entries authored by, or with a co-author trailer for, one of the user's emails. */
function gitLog(repo: LocalRepo, pattern: string): LogEntry[] {
  const format = `${RS}%H${FS}%ae${FS}%cI${FS}%s${FS}%B${END}`
  const base = ['log', '--no-merges', '--shortstat', `--format=${format}`, ...repo.refs, '-E', '-i']
  const byAuthor = tryRun('git', [...base, `--author=${pattern}`], repo.absPath) ?? ''
  const byTrailer =
    tryRun('git', [...base, `--grep=^co-authored-by:.*<(${pattern})>`], repo.absPath) ?? ''
  return `${byAuthor}${byTrailer}`
    .split(RS)
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => parseLogChunk(chunk))
}

/** The user's authored and co-authored commits on a clone's refs. */
export function localChanges(repo: LocalRepo, window: LocalWindow): Change[] {
  if (repo.refs.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const out: Change[] = []
  for (const entry of gitLog(repo, window.pattern)) {
    const entryRole = role(entry.email, entry.message, window.pattern)
    if (
      !seen.has(entry.sha) &&
      entryRole !== null &&
      inWindow(entry.date, window.since, window.until)
    ) {
      out.push(entryToChange(repo.repo, entry, entryRole))
    }
    seen.add(entry.sha)
  }
  return out
}

/** A file's text; null when it is missing, a folder, or unreadable. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** First prose line of a folder's README. */
export function readmeLine(dir: string): string | null {
  const readme = entries(dir).find(
    (entry) => !entry.isDirectory() && /^readme(?:\.md)?$/iu.test(entry.name),
  )
  const text = readme === undefined ? null : readText(path.join(dir, readme.name))
  if (text === null) {
    return null
  }
  const line = text
    .split('\n')
    .map((row) => row.replace(/^#+\s*/u, '').trim())
    .find((row) => row !== '' && !row.startsWith('<') && !row.startsWith('!['))
  return line ?? null
}

/** The day a file last changed; none for a dangling link or a file that cannot be read. */
function modifiedDay(file: string): string[] {
  try {
    return [isoDay(new Date(statSync(file).mtimeMs).toISOString())]
  } catch {
    return []
  }
}

function fileDays(dir: string): string[] {
  return entries(dir)
    .filter((entry) => isScannable(entry.name))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory() ? fileDays(file) : modifiedDay(file)
    })
}

/** A package.json's content; null when it is missing or not JSON. */
function parsePackage(text: string | null): unknown {
  try {
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

function packageDescription(dir: string): string | null {
  const parsed = parsePackage(readText(path.join(dir, 'package.json')))
  const description =
    typeof parsed === 'object' && parsed !== null && 'description' in parsed
      ? parsed.description
      : null
  return typeof description === 'string' ? description : null
}

/** A folder without git, dated by its files. */
export function noGitRecord(root: string, folder: string): RepoRecord {
  const dir = path.join(root, folder)
  const exists = existsSync(dir)
  const days = exists ? fileDays(dir).toSorted() : []
  return {
    type: 'repo',
    repo: `local:${folder}`,
    canonical: null,
    localPath: dir,
    branches: [],
    description: exists ? (packageDescription(dir) ?? readmeLine(dir)) : null,
    first: days.at(0) ?? null,
    last: days.at(-1) ?? null,
    counts: { author: 0, 'co-author': 0 },
    warnings: ['no-git'],
  }
}
