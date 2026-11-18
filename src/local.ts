import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  repoFromRemoteUrl,
  resolveAlias,
  stripPrSuffix,
} from './helpers.ts'
import type { Change, Role } from './types.ts'

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

/** A folder from the config as an absolute path. */
export function resolveDir(dir: string): string {
  return path.resolve(expandHome(dir))
}

/** The config value keyed by a clone's path, however that path is written. */
function forPath<T>(map: Readonly<Record<string, T>>, absPath: string): T | undefined {
  return Object.entries(map).find(([dir]) => resolveDir(dir) === absPath)?.[1]
}

/** A folder's entries; none when it cannot be read. */
export function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export function isScannable(name: string): boolean {
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

function cloneWarnings(absPath: string, refs: readonly string[]): string[] {
  const stale = isStale(absPath) ? ['stale-clone'] : []
  return refs.length === 0 ? [...stale, 'no-default-ref'] : stale
}

/**
 * A name for a clone with no remote: its path under `folder`, with more of
 * its full path in front while another such clone has that name.
 */
function pathName(folder: string, absPath: string, taken: ReadonlySet<string>): string {
  const parts = absPath.split(path.sep).filter((part) => part !== '')
  const least = Math.max(1, path.relative(folder, absPath).split(path.sep).length)
  const names = parts
    .map((_part, index) => parts.slice(index).join('/'))
    .filter((_name, index) => parts.length - index >= least)
    .toReversed()
  return names.find((name) => !taken.has(name)) ?? absPath
}

/**
 * A clone found under `folder`. With no remote to name it, its path does, and
 * that name is added to `pathNames` so the next such clone gets another.
 */
function localRepo(
  cfg: BackfillConfig,
  { folder, absPath }: { folder: string; absPath: string },
  pathNames: Set<string>,
): LocalRepo {
  const originUrl = tryRun('git', ['remote', 'get-url', 'origin'], absPath) ?? ''
  const known = forPath(cfg.remote, absPath) ?? repoFromRemoteUrl(originUrl)
  const raw = known ?? pathName(folder, absPath, pathNames)
  if (known === null) {
    pathNames.add(raw)
  }
  const refs = resolveLocalRefs(absPath, forPath(cfg.branches, absPath))
  return {
    absPath,
    repo: resolveAlias(raw, cfg.aliases),
    refs,
    warnings: cloneWarnings(absPath, refs),
  }
}

/**
 * Every git clone under the configured folders, skipping `noGit` ones; each
 * clone once. Outer folders are read first, so a clone with no remote has the
 * same name in whatever order the folders are listed.
 */
export function localRepos(cfg: BackfillConfig): LocalRepo[] {
  const skipped = new Set(cfg.noGit.map((folder) => resolveDir(folder)))
  const folders = [...new Set(cfg.folders.map((dir) => resolveDir(dir)))].toSorted(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )
  const found = new Map<string, LocalRepo>()
  const pathNames = new Set<string>()
  for (const folder of folders) {
    const clones = skipped.has(folder) ? [] : findGitDirs(folder, SCAN_DEPTH)
    for (const absPath of clones.filter((dir) => !found.has(dir))) {
      found.set(absPath, localRepo(cfg, { folder, absPath }, pathNames))
    }
  }
  return [...found.values()]
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
